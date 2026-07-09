/**
 * Auth Service — JWT issuer + introspection.
 *
 * Issues short-lived access tokens + long-lived refresh tokens.
 * Stores users in MySQL.
 * Passwords are bcrypt-hashed; refresh tokens are JWT with jti claim.
 *
 * Endpoints:
 *   POST /login        — exchange credentials for access+refresh tokens
 *   POST /refresh      — exchange refresh token for new access token
 *   POST /introspect   — validate a token and return its claims
 *   GET  /me           — current user info (Bearer)
 *   POST /logout       — invalidate refresh token (single-use)
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'auth-service';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../../shared/config');
const { logger, withCorrelation } = require('../../shared/logger');
const { correlationMiddleware, sendProblemJson } = require('../../shared/utils/helpers');
const { requestLogger } = require('../../shared/middleware/logger');
const { errorHandler } = require('../../shared/middleware/errorHandler');
const { rateLimiter } = require('../../shared/middleware/rateLimiter');
const { metricsMiddleware, metricsHandler } = require('../../shared/metrics');

const log = withCorrelation('-');
log.info('auth_service_boot', { port: config.port.auth, issuer: config.security.jwtIssuer });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.security.corsOrigins }));
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(correlationMiddleware);
app.use(metricsMiddleware());
app.use(requestLogger);
app.use(rateLimiter);

// === User store (MySQL) ===

const mysql = require('mysql2/promise');

const pool = mysql.createPool(config.storage.mysql);

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        employee_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL,
        branch_code VARCHAR(255),
        active TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        jti VARCHAR(255) PRIMARY KEY,
        employee_id VARCHAR(255) NOT NULL,
        revoked TINYINT DEFAULT 0,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err) {
    log.error('auth_db_init_failed', { error: err.message });
  }
}

initDb();

async function findUserByEmail(email) {
  const [rows] = await pool.query(`SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1`, [email]);
  return rows[0];
}

async function findUserById(id) {
  const [rows] = await pool.query(`SELECT employee_id, name, email, role, branch_code, active FROM users WHERE employee_id = ?`, [id]);
  return rows[0];
}

async function insertRefreshToken(jti, employeeId, ttlSeconds) {
  await pool.query(
    `INSERT INTO refresh_tokens(jti, employee_id, expires_at) VALUES (?,?,?)`,
    [jti, employeeId, Date.now() + ttlSeconds * 1000]
  );
}

async function revokeRefreshToken(jti) {
  await pool.query(`UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?`, [jti]);
}

async function isRefreshTokenRevoked(jti) {
  const [rows] = await pool.query(`SELECT revoked, expires_at FROM refresh_tokens WHERE jti = ?`, [jti]);
  return rows[0] || null;
}

// JWT helpers
function signAccessToken(user) {
  return jwt.sign(
    { sub: user.employee_id, name: user.name, role: user.role, branch_code: user.branch_code },
    config.security.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.security.jwtAccessTtlSeconds,
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    }
  );
}

function signRefreshToken(user) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { sub: user.employee_id, jti, type: 'refresh' },
    config.security.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.security.jwtRefreshTtlSeconds,
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    }
  );
  return { token, jti };
}

function authenticateJwt(req, res, next) {
  // Read access token from the HttpOnly cookie
  const token = req.cookies?.access_token;
  if (!token) {
    return sendProblemJson(res, 401, 'UNAUTHENTICATED', 'Missing access token cookie.', req.traceparent);
  }
  try {
    const decoded = jwt.verify(token, config.security.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    });
    if (decoded.type === 'refresh') return sendProblemJson(res, 401, 'WRONG_TOKEN_TYPE', 'Use an access token, not a refresh token.', req.traceparent);
    req.user = decoded;
    next();
  } catch (err) {
    return sendProblemJson(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token.', req.traceparent);
  }
}

// === Endpoints ===

app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return sendProblemJson(res, 400, 'MISSING_REQUIRED_FIELD', 'email and password are required', req.traceparent);
  const user = await findUserByEmail(email);
  if (!user) return sendProblemJson(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.', req.traceparent);
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return sendProblemJson(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.', req.traceparent);

  const access = signAccessToken(user);
  const { token: refresh, jti } = signRefreshToken(user);
  await insertRefreshToken(jti, user.employee_id, config.security.jwtRefreshTtlSeconds);

  // Set tokens in secure, HttpOnly cookies instead of returning in the body
  res.cookie('access_token', access, {
    httpOnly: true,
    secure: config.isProd, // Use secure cookies in production
    sameSite: 'strict',
    maxAge: config.security.jwtAccessTtlSeconds * 1000,
  });

  res.cookie('refresh_token', refresh, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/api/v1/auth/refresh', // Scope refresh token to its endpoint
    maxAge: config.security.jwtRefreshTtlSeconds * 1000,
  });

  log.info('auth_login_ok', { employee_id: user.employee_id, role: user.role });
  res.status(200).json({
    // The response body should only contain non-sensitive user info
    status: 'success',
    user: { employee_id: user.employee_id, name: user.name, email: user.email, role: user.role, branch_code: user.branch_code },
  });
});

app.post('/api/v1/auth/refresh', async (req, res) => {
  // Read refresh token from the HttpOnly cookie
  const refresh_token = req.cookies?.refresh_token;
  if (!refresh_token) return sendProblemJson(res, 400, 'MISSING_REQUIRED_FIELD', 'refresh_token is required', req.traceparent);
  let decoded;
  try {
    decoded = jwt.verify(refresh_token, config.security.jwtSecret, {
      algorithms: ['HS256'],
      ignoreExpiration: false, // Enforce expiration check
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    });
  } catch {
    return sendProblemJson(res, 401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.', req.traceparent);
  }
  if (decoded.type !== 'refresh') return sendProblemJson(res, 401, 'WRONG_TOKEN_TYPE', 'Not a refresh token.', req.traceparent);
  const rec = await isRefreshTokenRevoked(decoded.jti);
  if (!rec || rec.revoked) return sendProblemJson(res, 401, 'REVOKED_REFRESH_TOKEN', 'Refresh token revoked.', req.traceparent);
  if (rec.expires_at < Date.now()) return sendProblemJson(res, 401, 'EXPIRED_REFRESH_TOKEN', 'Refresh token expired.', req.traceparent);

  const user = await findUserById(decoded.sub);
  if (!user || !user.active) return sendProblemJson(res, 401, 'USER_DISABLED', 'User no longer active.', req.traceparent);

  // Rotate: revoke old, issue new
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?`, [decoded.jti]);
    const access = signAccessToken(user);
    const { token: newRefresh, jti } = signRefreshToken(user);
    await connection.query(
      `INSERT INTO refresh_tokens(jti, employee_id, expires_at) VALUES (?,?,?)`,
      [jti, user.employee_id, Date.now() + config.security.jwtRefreshTtlSeconds * 1000]
    );
    await connection.commit();

    // Set new tokens in secure, HttpOnly cookies
    res.cookie('access_token', access, {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'strict',
      maxAge: config.security.jwtAccessTtlSeconds * 1000,
    });
    res.cookie('refresh_token', newRefresh, {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'strict',
      path: '/api/v1/auth/refresh',
      maxAge: config.security.jwtRefreshTtlSeconds * 1000,
    });
    res.status(200).json({ status: 'success', user: { employee_id: user.employee_id, name: user.name, email: user.email, role: user.role, branch_code: user.branch_code } });
  } catch (err) {
    await connection.rollback();
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to rotate token.', req.traceparent);
  } finally {
    connection.release();
  }


});

app.post('/api/v1/auth/introspect', (req, res) => {
  const { token } = req.body || {};
  if (!token) return sendProblemJson(res, 400, 'MISSING_REQUIRED_FIELD', 'token is required', req.traceparent);
  try {
    const decoded = jwt.verify(token, config.security.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    });
    res.status(200).json({ active: true, claims: decoded });
  } catch (err) {
    res.status(200).json({ active: false, error: 'Token validation failed' });
  }
});

app.get('/api/v1/auth/me', authenticateJwt, async (req, res) => {
  const u = await findUserById(req.user.sub);
  if (!u) return sendProblemJson(res, 404, 'USER_NOT_FOUND', 'User not found.', req.traceparent);
  res.status(200).json(u);
});

app.post('/api/v1/auth/logout', async (req, res) => {
  const refresh_token = req.cookies?.refresh_token;
  if (refresh_token) {
    try {
      const decoded = jwt.verify(refresh_token, config.security.jwtSecret, {
        algorithms: ['HS256'],
        issuer: config.security.jwtIssuer,
        audience: config.security.jwtAudience,
        ignoreExpiration: true, // Allow logout of expired tokens
      });
      await revokeRefreshToken(decoded.jti);
    } catch { /* ignore */ }
  }
  // Clear the cookies on the client
  res.clearCookie('access_token');
  res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
  res.status(200).json({ ok: true });
});

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'auth-service' }));
app.get('/health/startup', (req, res) => res.status(200).json({ status: 'started', service: 'auth-service' }));
app.get('/health/ready', (req, res) => res.status(200).json({
  status: 'ready',
  service: 'auth-service',
  uptime_seconds: process.uptime(),
  version: require('../../../package.json').version,
  users_seeded: true,
}));

app.get('/metrics', metricsHandler);
app.use(errorHandler);

const PORT = config.port.auth;
app.listen(PORT, () => log.info('auth_service_listening', { port: PORT }));

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
process.on('unhandledRejection', (err) => {
  log.error('unhandled_rejection', { error: err && err.message, stack: err && err.stack });
  // Exit immediately, allowing a container orchestrator to restart the service in a clean state.
  process.exit(1);
});
