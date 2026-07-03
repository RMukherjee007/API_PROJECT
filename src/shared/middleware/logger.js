/**
 * Structured HTTP request logger.
 *
 * Logs once per request at the end, with: method, path, status, duration_ms,
 * correlationId, employeeId, role, ip, user-agent. Level escalates on 5xx.
 */

const { logger } = require('../logger');

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const traceparent = req.traceparent || '-';
  const correlationId = req.correlationId || '-';

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger.log(level, 'http_request', {
      method: req.method,
      path: req.originalUrl || req.path,
      status,
      duration_ms: Math.round(durationMs * 100) / 100,
      correlationId,
      traceparent,
      employeeId: req.employeeId,
      role: req.userRole,
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
  });

  next();
}

module.exports = { requestLogger };