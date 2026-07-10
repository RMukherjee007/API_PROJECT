/**
 * Frontend (RM Portal) — static SPA.
 *
 * Serves the public/ folder. Adds a tiny reverse-proxy for /api/*
 * to the gateway so the SPA can use relative paths in any environment.
 *
 * Run with: PORT=3000 PUBLIC_API_BASE=http://localhost:8080
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'frontend';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');

const config = require('../shared/config');
const { withCorrelation } = require('../shared/logger');
const { buildSignedRequestHeaders, correlationMiddleware, safeFetch, sendProblemJson } = require('../shared/utils/helpers');

const log = withCorrelation('-');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(correlationMiddleware);
app.use(cookieParser());
app.use('/api', express.json({ limit: '1mb' }));

function gatewayUrlFor(req) {
  const strippedPath = req.originalUrl.replace(/^\/api/, '') || '/';
  return new URL(strippedPath, config.frontend.publicApiBase).toString();
}

function resolveUserContext(req) {
  // Read the JWT from the HttpOnly cookie sent by the browser.
  const token = req.cookies?.access_token;
  if (token) {
    try { // Verify the token to securely extract user context for signing.
      const decoded = jwt.verify(token, config.security.jwtSecret, {
        algorithms: ['HS256'],
        issuer: config.security.jwtIssuer,
        audience: config.security.jwtAudience,
      });
      return {
        employeeId: decoded.sub || decoded.employee_id || 'EMP-FRONTEND',
        userRole: decoded.role || 'RM',
      };
    } catch (err) {
      log.error('jwt_verification_failed', { error: err.message });
      // If token verification fails for any reason, re-throw the error to force a 401.
      throw err;
    }
  }
  if (config.isProd) {
    return { employeeId: 'EMP-FRONTEND', userRole: 'RM' };
  }
  return {
    employeeId: req.headers['x-employee-id'] || 'EMP-FRONTEND',
    userRole: req.headers['x-user-role'] || 'RM',
  };
}

app.use('/api', async (req, res) => {
  const method = req.method.toUpperCase();
  const body = ['GET', 'HEAD'].includes(method) ? '' : JSON.stringify(req.body || {});
  const targetUrl = gatewayUrlFor(req);
  const targetPath = new URL(targetUrl).pathname;
  let employeeId;
  let userRole;
  try {
    ({ employeeId, userRole } = resolveUserContext(req));
  } catch {
    return sendProblemJson(res, 401, 'UNAUTHENTICATED', 'A valid session token is required.', req.traceparent);
  }
  const headers = buildSignedRequestHeaders({
    secret: config.security.hmacSecret,
    method,
    path: targetPath,
    body,
    employeeId,
    userRole,
    extraHeaders: {
      'content-type': 'application/json',
      'x-correlation-id': req.correlationId,
      traceparent: req.traceparent, // Forward the cookie header to allow downstream services to validate the session.
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      ...(method === 'POST' && targetPath === '/optimize' ? { 'Idempotency-Key': req.headers['idempotency-key'] || randomUUID() } : {}),
    },
  });

  try {
    const upstream = await safeFetch(targetUrl, {
      method,
      headers,
      body: body || undefined,
    }, { timeoutMs: 10000, retries: 1 });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    for (const header of ['content-type', 'content-disposition', 'x-portfolio-source', 'x-idempotency-replay']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.send(responseBody);
  } catch (err) {
    log.warn('frontend_gateway_proxy_failed', { error: err.message, path: req.originalUrl, correlationId: req.correlationId });
    sendProblemJson(res, 503, 'DEPENDENCY_TIMEOUT', 'Gateway is unreachable.', req.traceparent);
  }
});

// Serve SPA
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const PORT = config.port.frontend;
if (require.main === module) {
  server.listen(PORT, () => log.info('frontend_listening', { port: PORT, publicApi: config.frontend.publicApiBase }));
}

module.exports = { app, server };
