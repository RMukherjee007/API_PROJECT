/**
 * Audit Service — microservice.
 *
 * Owns:
 *  - Persistent storage of every optimization event.
 *  - Query, filter, and paginate suggestion history.
 *  - Retention policy + housekeeping.
 *
 * Endpoints:
 *   POST  /events                  — ingest (HMAC-signed)
 *   GET   /logs                    — paginated query
 *   GET   /recommendations/:id     — fetch by id
 *   GET   /recommendations/:id/pdf — PDF on-demand (proxies yield-engine)
 *   GET   /customers/:id/summary   — customer history summary
 *   GET   /stats                   — counts
 *   GET  /metrics                  — Prometheus
 *   GET  /health/{live,ready,startup}
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'audit-service';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const http = require('http');

const config = require('../../shared/config');
const { logger, withCorrelation } = require('../../shared/logger');
const { correlationMiddleware, sendProblemJson, safeFetch, buildSignedRequestHeaders } = require('../../shared/utils/helpers');
const { requestLogger } = require('../../shared/middleware/logger');
const { errorHandler } = require('../../shared/middleware/errorHandler');
const { rateLimiter } = require('../../shared/middleware/rateLimiter');
const { authenticateRequest } = require('../../shared/middleware/auth');
const { metricsMiddleware, metricsHandler, metrics } = require('../../shared/metrics');
const { AuditStore } = require('../../shared/storage/auditStore');
const { generateBulkPdfReport } = require('./bulkPdfGenerator');

const log = withCorrelation('-');
log.info('audit_service_boot', { port: config.port.audit, driver: config.storage.driver });

const store = new AuditStore({
  mysql: config.storage.mysql,
  recentCacheSize: 200,
});

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.security.corsOrigins }));
app.use(compression());
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(correlationMiddleware);
app.use(metricsMiddleware());
app.use(requestLogger);
app.use(rateLimiter);
app.use('/api/v1/audit', authenticateRequest);

// Ingest (HMAC required)
app.post('/api/v1/audit/events', async (req, res) => {
  const record = req.body || {};
  if (!record.recommendation_id || !record.customer_id) {
    return sendProblemJson(res, 400, 'MISSING_REQUIRED_FIELD', 'recommendation_id and customer_id are required.', req.traceparent);
  }
  try {
    await store.insert(record);
    metrics.auditTotal.inc();
    return res.status(202).json({ accepted: true, recommendation_id: record.recommendation_id });
  } catch (err) {
    if (/UNIQUE|duplicate|constraint/i.test(err.message)) {
      return sendProblemJson(res, 409, 'DUPLICATE_RECOMMENDATION_ID', 'recommendation_id already exists in the immutable audit ledger.', req.traceparent);
    }
    log.error('audit_ingest_failed', { error: err.message });
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to persist audit record.', req.traceparent);
  }
});

app.get('/api/v1/audit/logs', async (req, res) => {
  try {
    let { page = 1, limit = 50, customer_id, product, from_date, to_date, employee_id, role } = req.query;

    const callerEmployeeId = req.headers['x-employee-id'];
    const callerUserRole = req.headers['x-user-role'];
    if (callerUserRole !== 'ADMIN' && callerUserRole !== 'AUDITOR') {
      employee_id = callerEmployeeId;
    }

    const data = await store.query({ page: parseInt(page, 10), limit: parseInt(limit, 10), customer_id, product, from_date, to_date, employee_id, role });
    res.status(200).json({ ...data, source: 'audit-service' });
  } catch (err) {
    log.error('audit_query_failed', { error: err.message });
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to query audit logs.', req.traceparent);
  }
});

app.get('/api/v1/audit/logs/pdf', async (req, res) => {
  try {
    let { page = 1, limit = 50, customer_id, product, from_date, to_date, employee_id, role } = req.query;

    const callerEmployeeId = req.headers['x-employee-id'];
    const callerUserRole = req.headers['x-user-role'];
    if (callerUserRole !== 'ADMIN' && callerUserRole !== 'AUDITOR') {
      employee_id = callerEmployeeId;
    }

    // Harden against resource exhaustion by lowering the max limit for this expensive operation.
    const safeLimit = Math.min(50, parseInt(limit, 10));
    const data = await store.query({ page: parseInt(page, 10), limit: safeLimit, customer_id, product, from_date, to_date, employee_id, role });

    const pdfBuffer = await generateBulkPdfReport(data.logs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="bulk-report.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    log.error('bulk_pdf_failed', { error: err.message });
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate bulk PDF.', req.traceparent);
  }
});

app.get('/api/v1/audit/recommendations/:id', async (req, res) => {
  try {
    const rec = await store.getById(req.params.id);
    if (!rec) return sendProblemJson(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${req.params.id}".`, req.traceparent);

    const employeeId = req.headers['x-employee-id'];
    const userRole = req.headers['x-user-role'];
    if (userRole !== 'ADMIN' && userRole !== 'AUDITOR' && rec.employee_id !== employeeId) {
      return sendProblemJson(res, 403, 'FORBIDDEN', 'You do not have permission to view this recommendation.', req.traceparent);
    }

    res.status(200).json(rec);
  } catch (err) {
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to fetch recommendation.', req.traceparent);
  }
});

app.get('/api/v1/audit/recommendations/:id/pdf', async (req, res) => {
  try {
    const rec = await store.getById(req.params.id);
    if (!rec) return sendProblemJson(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${req.params.id}".`, req.traceparent);

    const employeeId = req.headers['x-employee-id'];
    const userRole = req.headers['x-user-role'];
    if (userRole !== 'ADMIN' && userRole !== 'AUDITOR' && rec.employee_id !== employeeId) {
      return sendProblemJson(res, 403, 'FORBIDDEN', 'You do not have permission to view this report.', req.traceparent);
    }

    const url = `${config.services.yieldEngineUrl}/reports/${encodeURIComponent(req.params.id)}`;
    const r = await safeFetch(url, {
      headers: buildSignedRequestHeaders({
        secret: config.security.hmacSecret,
        method: 'GET',
        path: new URL(url).pathname,
        employeeId: employeeId || req.headers['x-employee-id'] || 'AUDIT_SERVICE',
        userRole: userRole || req.headers['x-user-role'] || 'SERVICE',
        extraHeaders: { traceparent: req.traceparent },
      }),
    }, { timeoutMs: 5000, retries: 1 });
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="yield-report-${req.params.id}.pdf"`);
    res.send(buf);
  } catch (err) {
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to fetch PDF.', req.traceparent);
  }
});

app.get('/api/v1/audit/customers/:id/summary', async (req, res) => {
  try {
    const employeeId = req.headers['x-employee-id'];
    const userRole = req.headers['x-user-role'];
    const filterEmpId = (userRole === 'ADMIN' || userRole === 'AUDITOR') ? undefined : employeeId;

    const data = await store.query({ page: 1, limit: 200, customer_id: req.params.id, employee_id: filterEmpId });
    const products = {};
    let last = null;
    for (const l of data.logs) {
      products[l.recommended_product] = (products[l.recommended_product] || 0) + 1;
      if (!last || new Date(l.computed_at) > new Date(last.computed_at)) last = l;
    }
    res.status(200).json({
      customer_id: req.params.id,
      total_recommendations: data.total,
      last_recommendation: last,
      product_distribution: products,
      recent_logs: data.logs.slice(0, 25),
    });
  } catch (err) {
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to build customer summary.', req.traceparent);
  }
});

app.get('/api/v1/audit/stats', async (req, res) => {
  try {
    const stats = await store.stats();
    res.status(200).json({ ...stats, retention_days: config.log.auditRetentionDays });
  } catch (err) {
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to compute stats.', req.traceparent);
  }
});

// Health
app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'audit-service' }));
app.get('/health/startup', (req, res) => res.status(store.ready ? 200 : 503).json({ status: store.ready ? 'started' : 'starting' }));
app.get('/health/ready', async (req, res) => {
  try {
    const stats = await store.stats();
    res.status(200).json({
      status: store.ready ? 'ready' : 'starting',
      service: 'audit-service',
      uptime_seconds: process.uptime(),
      storage: { driver: config.storage.driver, ready: store.ready },
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: 'Storage engine unavailable' });
  }
});

app.get('/metrics', metricsHandler);

app.use(errorHandler);

const PORT = config.port.audit;
if (require.main === module) {
  server.listen(PORT, () => log.info('audit_service_listening', { port: PORT }));
}

// Retention sweeper
let sweeperInterval = null;
function scheduleSweep(delayMs = 60 * 60 * 1000) {
  sweeperInterval = setTimeout(async () => {
    try {
      const days = config.log.auditRetentionDays;
      const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      if (config.storage.driver === 'mysql') {
        await store.pool.query(`DELETE FROM audit_logs WHERE created_at < ?`, [cutoff]);
      }
      scheduleSweep(60 * 60 * 1000); // Reset to 1 hour
    } catch (err) {
      log.warn('audit_retention_sweep_error', { error: err.message });
      scheduleSweep(Math.min(delayMs * 2, 60 * 60 * 1000));
    }
  }, delayMs).unref();
}
scheduleSweep();

// Graceful shutdown
function shutdown(sig) {
  if (sweeperInterval) clearTimeout(sweeperInterval);
  log.info('audit_service_shutdown_begin', { signal: sig });
  server.close(() => store.close().then(() => process.exit(0)).catch(() => process.exit(1)));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { error: err && err.message }));
process.on('uncaughtException', (err) => log.error('uncaught_exception', { error: err.message, stack: err.stack }));

module.exports = { app, store, server };
