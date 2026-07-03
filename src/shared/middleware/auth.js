/**
 * Authentication middleware.
 *
 * Two layers:
 *   1. authenticateRequest — verifies HMAC-SHA256 of `ts|METHOD|path|sha256(body)`.
 *      This proves the caller holds the shared secret. (Machine-to-machine.)
 *   2. authenticateJwt — verifies a Bearer JWT issued by the auth-service.
 *      This proves the identity of a human user. (Browser / SPA.)
 *
 * Additionally, authenticateRequest populates req.employeeId / req.userRole,
 * and requireOverrideRole enforces role-based policy on overrides.
 *
 * HMAC signing string: `{ts}|{METHOD}|{path}|{sha256-hex(body)}`
 * Constant-time comparison via crypto.timingSafeEqual.
 * Timestamp skew bound is configurable.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { sendProblemJson, sha256Hex, hmacSha256Hex } = require('../utils/helpers');
const { logger } = require('../logger');

const ALLOWED_ROLES = new Set(['RM', 'SENIOR_RM', 'TREASURY', 'ADMIN', 'AUDITOR', 'SERVICE']);

function safeJsonStringify(obj) {
  // Stable canonical JSON for signature (sorted keys, no whitespace)
  if (obj === undefined || obj === null) return '';
  const seen = new WeakSet();
  return JSON.stringify(obj, function (key, value) {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}

function buildSigningString(timestamp, method, path, bodyHash) {
  return `${timestamp}|${method.toUpperCase()}|${path}|${bodyHash}`;
}

function authenticateRequest(req, res, next) {
  const traceparent = req.traceparent;

  const timestamp = req.headers['x-gateway-timestamp'];
  if (!timestamp) {
    return sendProblemJson(res, 401, 'TIMESTAMP_SKEW', 'Missing X-Gateway-Timestamp header.', traceparent);
  }
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return sendProblemJson(res, 401, 'TIMESTAMP_SKEW', 'X-Gateway-Timestamp must be numeric (epoch ms).', traceparent);
  }
  const skewMs = Math.abs(Date.now() - tsNum);
  if (skewMs > config.security.timestampSkewSeconds * 1000) {
    return sendProblemJson(res, 401, 'TIMESTAMP_SKEW', `X-Gateway-Timestamp deviates more than ±${config.security.timestampSkewSeconds}s from server time.`, traceparent);
  }

  const signature = req.headers['x-internal-signature'];
  if (!signature) {
    return sendProblemJson(res, 401, 'MISSING_SIGNATURE', 'Missing X-Internal-Signature header.', traceparent);
  }

  // Compute body hash over the raw body when present; otherwise empty string.
  const bodyString = req.rawBody !== undefined
    ? (req.rawBody.length === 0 ? '' : req.rawBody.toString('utf8'))
    : (req.body && Object.keys(req.body).length ? safeJsonStringify(req.body) : '');
  const bodyHash = sha256Hex(bodyString);
  const signedPath = (req.originalUrl || req.path || '').split('?')[0];
  const signingString = buildSigningString(timestamp, req.method, signedPath, bodyHash);
  const expectedSignature = hmacSha256Hex(config.security.hmacSecret, signingString);

  try {
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
      return sendProblemJson(res, 401, 'SIGNATURE_MISMATCH', 'X-Internal-Signature HMAC validation failed.', traceparent);
    }
    const sigBuffer = Buffer.from(signature, 'hex');
    const expBuffer = Buffer.from(expectedSignature, 'hex');
    if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
      logger.warn('hmac_signature_mismatch', {
        path: signedPath,
        method: req.method,
        correlationId: req.correlationId,
      });
      return sendProblemJson(res, 401, 'SIGNATURE_MISMATCH', 'X-Internal-Signature HMAC validation failed.', traceparent);
    }
  } catch {
    return sendProblemJson(res, 401, 'SIGNATURE_MISMATCH', 'X-Internal-Signature HMAC validation failed.', traceparent);
  }

  const role = req.headers['x-user-role'] || 'RM';
  const employeeId = req.headers['x-employee-id'] || 'UNKNOWN';
  if (!ALLOWED_ROLES.has(role)) {
    return sendProblemJson(res, 403, 'INSUFFICIENT_ROLE', `Role "${role}" is not authorized.`, traceparent);
  }

  req.userRole = role;
  req.employeeId = employeeId;
  req.signatureValid = true;
  next();
}

function authenticateJwt(req, res, next) {
  let token;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice('Bearer '.length).trim();
  } else if (req.query.token) {
    token = req.query.token;
  }
  
  if (!token) {
    return sendProblemJson(res, 401, 'UNAUTHENTICATED', 'Missing Bearer token.', req.traceparent);
  }
  try {
    const decoded = jwt.verify(token, config.security.jwtSecret, {
      algorithms: ['HS256'],
      issuer: config.security.jwtIssuer,
      audience: config.security.jwtAudience,
    });
    if (!ALLOWED_ROLES.has(decoded.role)) {
      return sendProblemJson(res, 403, 'INSUFFICIENT_ROLE', `Role "${decoded.role}" is not authorized.`, req.traceparent);
    }
    req.user = decoded;
    req.userRole = decoded.role;
    req.employeeId = decoded.sub;
    next();
  } catch (err) {
    logger.warn('jwt_verify_failed', { error: err.message, correlationId: req.correlationId });
    return sendProblemJson(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token.', req.traceparent);
  }
}

function requireOverrideRole(req, res, next) {
  const hasOverride = req.body && (req.body.fx_rate_overrides || req.body.market_rates_override);
  if (hasOverride && !['SENIOR_RM', 'TREASURY', 'ADMIN'].includes(req.userRole)) {
    return sendProblemJson(res, 403, 'INSUFFICIENT_ROLE', 'Only SENIOR_RM, TREASURY, or ADMIN can submit rate overrides.', req.traceparent);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return sendProblemJson(res, 403, 'INSUFFICIENT_ROLE', `Requires one of: ${roles.join(', ')}.`, req.traceparent);
    }
    next();
  };
}

module.exports = {
  authenticateRequest,
  authenticateJwt,
  requireOverrideRole,
  requireRole,
  buildSigningString,
  ALLOWED_ROLES,
};
