/**
 * Structured logger — winston-based JSON logger
 *
 * - All services share the same logger shape.
 * - In production, logs are JSON to stdout (12-factor) AND optionally to a
 *   rotated file under ./logs/.
 * - In development, we keep a colorized console output for readability.
 * - Every log line carries: timestamp, level, service, correlationId (trace), message, meta.
 */

const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const logDir = path.resolve(__dirname, '../../..', 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }

const correlationFormat = winston.format((info) => {
  if (!info.correlationId) info.correlationId = '-';
  if (!info.service) info.service = config.serviceName || 'unknown';
  
  // Datadog APM tracing integration fields
  if (info.correlationId !== '-') {
    info['dd.trace_id'] = info.correlationId;
    info['dd.span_id'] = info.correlationId; // Simplified for demo; ideally span_id is unique per span
  }
  
  return info;
})();

function sanitizeLogObject(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(/[\r\n]/g, ' ');
    } else if (typeof obj[key] === 'object') {
      sanitizeLogObject(obj[key]);
    }
  }
  return obj;
}

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  correlationFormat,
  winston.format.errors({ stack: true }),
  winston.format.json({ replacer: (key, value) => typeof value === 'string' ? value.replace(/[\r\n]/g, ' ') : value })
);

const consoleFormat = config.env === 'production'
  ? baseFormat
  : winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    correlationFormat,
    winston.format.errors({ stack: true }),
    winston.format.colorize({ all: true }),
    winston.format.printf((info) => {
      const { timestamp, level, service, correlationId, message, ...meta } = info;
      const sanitizedMeta = sanitizeLogObject(meta);
      const metaStr = Object.keys(sanitizedMeta).length ? ' ' + JSON.stringify(sanitizedMeta) : '';
      return `${timestamp} [${level}] (${service} cid=${correlationId}) ${message}${metaStr}`;
    })
  );

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
];

if (config.logging.file) {
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(logDir, `${config.serviceName || 'app'}-%DATE%.log`),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: baseFormat,
    })
  );
}

const logger = winston.createLogger({
  level: config.log.level || 'info',
  transports,
  exitOnError: false,
  silent: config.env === 'test',
});

/**
 * Create a child logger with a stable correlationId.
 */
function withCorrelation(correlationId) {
  return logger.child({ correlationId });
}

module.exports = { logger, withCorrelation };