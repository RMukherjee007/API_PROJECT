/**
 * Prometheus metrics.
 *
 * Default + HTTP + business metrics. Idempotent across modules via a shared registry.
 */

const client = require('prom-client');
const config = require('../config');

const register = new client.Registry();
register.setDefaultLabels({ service: config.serviceName, env: config.env });
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['service', 'method', 'path', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests total',
  labelNames: ['service', 'method', 'path', 'status'],
  registers: [register],
});

const optimizeTotal = new client.Counter({
  name: 'optimize_requests_total',
  help: 'Optimize requests total',
  labelNames: ['recommended_product', 'role', 'override_used'],
  registers: [register],
});

const optimizeDuration = new client.Histogram({
  name: 'optimize_duration_seconds',
  help: 'Optimize math engine duration',
  labelNames: ['recommended_product'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const fxFeedUp = new client.Gauge({
  name: 'fx_feed_up',
  help: '1 if live FX feed reachable, 0 if fallback',
  registers: [register],
});

const auditTotal = new client.Gauge({
  name: 'audit_logs_total',
  help: 'Total persisted audit log count',
  registers: [register],
});

function metricsMiddleware() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = {
        service: config.serviceName,
        method: req.method,
        path: (req.route?.path || req.path || '').replace(/[a-f0-9-]{36}/g, ':id') || 'unknown',
        status: String(res.statusCode),
      };
      httpRequestDuration.observe(labels, duration);
      httpRequestTotal.inc(labels);
    });
    next();
  };
}

async function metricsHandler(_req, res) {
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = {
  register,
  metricsMiddleware,
  metricsHandler,
  metrics: {
    optimizeTotal,
    optimizeDuration,
    fxFeedUp,
    auditTotal,
  },
};