/**
 * Shared utility helpers.
 *
 * - generateTraceparent / generateCorrelationId — W3C trace context.
 * - sendProblemJson — RFC 7807 application/problem+json envelope.
 * - formatCurrency / formatPct — bank-style decimal strings.
 * - safeFetch — fetch with retry, timeout, and circuit-breaker behavior.
 * - sleep / wait — promise-based timers.
 */

const crypto = require('crypto');

function generateTraceparent(spanId) {
  const traceId = crypto.randomBytes(16).toString('hex');
  const sid = spanId || crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${sid}-01`;
}

function extractCorrelationId(req) {
  // W3C traceparent > x-correlation-id > generate
  const tp = req.headers?.traceparent;
  if (tp && typeof tp === 'string') {
    const parts = tp.split('-');
    if (parts.length >= 2 && /^[0-9a-f]{32}$/.test(parts[1])) return parts[1];
  }
  if (req.headers?.['x-correlation-id']) return String(req.headers['x-correlation-id']);
  return crypto.randomBytes(16).toString('hex');
}

function correlationMiddleware(req, res, next) {
  const cid = extractCorrelationId(req);
  req.correlationId = cid;
  req.traceparent = req.headers?.traceparent || `00-${cid}-${crypto.randomBytes(8).toString('hex')}-01`;
  res.setHeader('X-Correlation-ID', cid);
  next();
}

function sendProblemJson(res, status, errorCode, detail, traceparent, invalidFields = null, instance = null) {
  const type = `https://api.bank.com/errors/${errorCode.toLowerCase().replace(/_/g, '-')}`;
  const title = errorCode
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  const body = {
    type,
    title,
    status,
    detail,
    instance: traceparent || instance || `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`,
    error_code: errorCode,
    timestamp: new Date().toISOString(),
  };
  if (invalidFields) body.invalid_fields = invalidFields;
  return res.status(status).type('application/problem+json').json(body);
}

function sha256Hex(message = '') {
  const safeMessage = typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message);
  return crypto.createHash('sha256').update(safeMessage).digest('hex');
}

function hmacSha256Hex(secret, message) {
  const safeMessage = typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message);
  return crypto.createHmac('sha256', secret).update(safeMessage).digest('hex');
}

function buildSignedRequestHeaders({ secret, method, path, body = '', timestamp = Date.now().toString(), employeeId, userRole, extraHeaders = {} }) {
  const bodyHash = sha256Hex(body);
  const signingString = `${timestamp}|${String(method || 'GET').toUpperCase()}|${path}|${bodyHash}`;
  return {
    ...extraHeaders,
    'X-Gateway-Timestamp': timestamp,
    'X-Internal-Signature': hmacSha256Hex(secret, signingString),
    ...(employeeId ? { 'X-Employee-ID': employeeId } : {}),
    ...(userRole ? { 'X-User-Role': userRole } : {}),
  };
}

function formatCurrency(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '0.00';
  return Number(value).toFixed(decimals);
}

function formatPct(value, decimals = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '0.0000';
  return Number(value).toFixed(decimals);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout + bounded retries.
 * Throws on non-retryable errors (4xx). Retries on 5xx and network errors.
 */
async function safeFetch(url, options = {}, { timeoutMs = 5000, retries = 2, backoffMs = 200 } = {}) {
  const attempt = async (n) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);
      if (!res.ok && res.status >= 500 && n < retries) {
        await sleep(backoffMs * (n + 1));
        return attempt(n + 1);
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      if (n < retries) {
        await sleep(backoffMs * (n + 1));
        return attempt(n + 1);
      }
      throw err;
    }
  };
  return attempt(0);
}

/**
 * Lightweight per-host circuit breaker.
 * - CLOSED: requests flow. On consecutive failures, opens.
 * - OPEN: rejects immediately until cool-down elapses.
 * - HALF_OPEN: allows one probe. If it succeeds, closes. If not, opens again.
 */
class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.state = 'CLOSED';
    this.openedAt = 0;
  }
  recordSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }
  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
  canPass() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN' && Date.now() - this.openedAt > this.cooldownMs) {
      this.state = 'HALF_OPEN';
      return true;
    }
    return this.state === 'HALF_OPEN';
  }
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  generateTraceparent,
  extractCorrelationId,
  correlationMiddleware,
  sendProblemJson,
  sha256Hex,
  hmacSha256Hex,
  buildSignedRequestHeaders,
  formatCurrency,
  formatPct,
  sleep,
  safeFetch,
  CircuitBreaker,
  nowIso,
};
