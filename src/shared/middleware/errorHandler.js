/**
 * Centralized error handler.
 *
 * - Returns RFC 7807 application/problem+json.
 * - Includes traceparent, correlationId, timestamp.
 * - Logs stack only outside production.
 */

const config = require('../config');
const { logger } = require('../logger');

function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const errorCode = err.errorCode || 'INTERNAL_SERVER_ERROR';
  logger.log(status >= 500 ? 'error' : 'warn', 'http_error', {
    method: req.method,
    path: req.originalUrl || req.path,
    status,
    errorCode,
    message: err.message,
    correlationId: req.correlationId,
    stack: config.isProd ? undefined : err.stack,
  });
  const detail = config.isProd
    ? 'An unexpected error occurred. Please try again later.'
    : err.message;
  res.status(status).type('application/problem+json').json({
    type: `https://api.bank.com/errors/${errorCode.toLowerCase().replace(/_/g, '-')}`,
    title: errorCode.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '),
    status,
    detail,
    instance: req.traceparent || `00-${Math.random().toString(16).slice(2, 18)}-0000000000000000-01`,
    error_code: errorCode,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { errorHandler };