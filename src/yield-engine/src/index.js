/**
 * Yield Engine service — entrypoint.
 *
 *  - POST /optimize                — main FCNR vs NRE yield recommendation
 *  - GET  /recommendations/:id     — fetch a stored recommendation
 *  - GET  /rates                   — policy + live FX snapshot
 *  - GET  /recent-suggestions                 — recent optimization events
 *  - GET  /logs                    — paginated audit log (delegated to audit-service when configured)
 *  - GET  /reports/:id             — PDF report
 *  - GET  /metrics                 — Prometheus
 *  - GET  /health/{live,ready,startup}
 *
 * The engine now:
 *  - Publishes every optimization event to the audit-service (if reachable).
 *  - Persists a local ring buffer (in-memory) keyed by rec_id for fast retrieval
 *    even when audit-service is temporarily down (graceful degradation).
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'yield-engine';
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
const { computeYield, validateOptimizeRequest } = require('./engine');
const { LiveRateFeed } = require('./rateFeed');
const { generatePdfReport } = require('./reportGenerator');

const log = withCorrelation('-');
log.info('yield_engine_boot', { port: config.port.yieldEngine, env: config.env });

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: false, // yields a JSON API; CSP irrelevant
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: config.security.corsOrigins }));
app.use(compression());
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(correlationMiddleware);
app.use(metricsMiddleware());
app.use(requestLogger);
app.use(rateLimiter);

app.use([
  '/optimize',
  '/recommendations',
  '/rates',
  '/recent-suggestions',
  '/logs',
  '/reports',
], authenticateRequest);

// In-memory ring buffer of recent optimizations (fast path; persistent storage lives in audit-service).
const RECENT_BUFFER_SIZE = 1000;
const recentById = new Map();
const recentList = [];

function rememberOptimization(recId, body, ctx) {
  recentById.set(recId, { body, ctx, storedAt: Date.now() });
  recentList.push(recId);
  if (recentList.length > RECENT_BUFFER_SIZE) {
    const drop = recentList.shift();
    recentById.delete(drop);
  }
}

function getRecentOptimization(recId) {
  return recentById.get(recId);
}

function listRecentOptimizations(limit = 50) {
  const ids = recentList.slice(-Math.max(1, limit)).reverse();
  return ids.map((id) => {
    const e = recentById.get(id);
    return { recommendation_id: id, ...summarize(e) };
  });
}

function summarize(entry) {
  if (!entry) return null;
  const { body, ctx } = entry;
  return {
    customer_id: body.metadata.customer_id,
    recommended_product: body.advisory.recommended_product,
    fcnr_yield: body.decision_trace.fcnr_effective_yield_pct,
    nre_yield: body.decision_trace.nre_effective_yield_pct,
    principal_amount: ctx.input?.principal_amount,
    base_currency: ctx.input?.base_currency,
    tenure_months: ctx.input?.tenure_months,
    employee_id: ctx.employeeId,
    user_role: ctx.userRole,
    computed_at: body.metadata.computed_at,
    execution_time_ms: body.metadata.execution_time_ms,
    traceparent: body.metadata.traceparent,
  };
}

// Audit-service handoff: best-effort, with backoff
async function publishToAuditService(record) {
  try {
    const url = `${config.services.auditUrl}/api/v1/audit/events`;
    const body = JSON.stringify(record);
    const r = await safeFetch(`${config.services.auditUrl}/api/v1/audit/events`, {
      method: 'POST',
      headers: buildSignedRequestHeaders({
        secret: config.security.hmacSecret,
        method: 'POST',
        path: new URL(url).pathname,
        body,
        employeeId: record.employee_id || 'YIELD_ENGINE',
        userRole: 'SERVICE',
        extraHeaders: { 'content-type': 'application/json', traceparent: record.traceparent },
      }),
      body,
    }, { timeoutMs: 2000, retries: 1 });
    if (!r.ok) {
      log.warn('audit_publish_non_ok', { status: r.status });
    }
  } catch (err) {
    log.warn('audit_publish_failed', { error: err.message });
  }
}

const rateFeed = new LiveRateFeed();

// === Endpoints ===

app.post('/optimize', async (req, res) => {
  const startedAt = Date.now();
  const traceparent = req.traceparent;
  const logBound = withCorrelation(req.correlationId);
  const employeeId = req.headers['x-employee-id'] || req.body?.employee_id || 'UNKNOWN';
  const userRole = req.headers['x-user-role'] || req.body?.user_role || 'RM';
  const portfolioSource = req.headers['x-portfolio-source'] || 'NOT_AVAILABLE';

  if (!rateFeed.isLive()) {
    return sendProblemJson(res, 503, 'MARKET_DATA_UNAVAILABLE', 'Bank TMS market data is unavailable.', traceparent);
  }

  let body = req.body || {};
  if (body.assets) body.assets = body.assets.map((a) => ({ ...a, market_value: a.market_value !== undefined && !isNaN(parseFloat(a.market_value)) ? parseFloat(a.market_value).toFixed(2) : a.market_value }));
  if (body.liabilities) body.liabilities = body.liabilities.map((l) => ({ ...l, outstanding_principal: l.outstanding_principal !== undefined && !isNaN(parseFloat(l.outstanding_principal)) ? parseFloat(l.outstanding_principal).toFixed(2) : l.outstanding_principal }));

  const validationError = validateOptimizeRequest(body, traceparent, rateFeed);
  if (validationError) {
    return sendProblemJson(res, validationError.status, validationError.errorCode, validationError.detail, traceparent, validationError.invalidFields);
  }

  let result;
  try {
    result = computeYield(body, { rateFeed, portfolioSource, userRole, employeeId, traceparent });
  } catch (err) {
    logBound.error('optimize_engine_error', { error: err.message, stack: err.stack });
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred while computing the recommendation.', traceparent);
  }

  // Decorate metadata with risk + principal + override info for PDF and audit
  result.metadata.customer_risk_profile = body.risk_profile;
  result.metadata.principal_amount = body.principal_amount;
  result.metadata.base_currency = body.base_currency;
  result.metadata.tenure_months = body.tenure_months;
  if (body.market_rates_override) {
    result.metadata.override_reason = body.market_rates_override.override_reason;
  }
  if (body.is_manual_override) {
    result.metadata.approved_by = body.approved_by;
    result.metadata.approval_timestamp = body.approval_timestamp;
    result.metadata.override_ticket_id = body.override_ticket_id;
  }

  const recommendationId = result.metadata.recommendation_id;

  rememberOptimization(recommendationId, result, {
    input: body,
    employeeId,
    userRole,
    traceparent,
  });

  // Build a flat audit record.
  const auditRecord = {
    recommendation_id: recommendationId,
    customer_id: body.customer_id,
    employee_id: employeeId,
    user_role: userRole,
    traceparent,
    input: body,
    decision_trace: result.decision_trace,
    compliance: result.compliance,
    advisory: result.advisory,
    metadata: result.metadata,
  };

  // Fire-and-forget: persist to audit-service.
  publishToAuditService(auditRecord).catch(() => {});

  metrics.optimizeTotal.inc({
    recommended_product: result.advisory.recommended_product,
    role: userRole,
    override_used: String(Boolean(body.market_rates_override || body.fx_rate_overrides)),
  });
  metrics.optimizeDuration.observe({ recommended_product: result.advisory.recommended_product }, (Date.now() - startedAt) / 1000);

  if (req.storeIdempotentResponse) req.storeIdempotentResponse(result);
  return res.status(200).json(result);
});

app.get('/recommendations/:recommendation_id', (req, res) => {
  const traceparent = req.traceparent;
  const local = getRecentOptimization(req.params.recommendation_id);
  const employeeId = req.headers['x-employee-id'];
  const userRole = req.headers['x-user-role'];
  
  if (!local) {
    // try audit-service
    safeFetch(`${config.services.auditUrl}/api/v1/audit/recommendations/${encodeURIComponent(req.params.recommendation_id)}`, {
      headers: {
        'x-employee-id': employeeId,
        'x-user-role': userRole,
        'x-gateway-timestamp': req.headers['x-gateway-timestamp'],
        'x-internal-signature': req.headers['x-internal-signature']
      }
    }, { timeoutMs: 1500, retries: 1 })
      .then(async (r) => {
        if (!r.ok) return sendProblemJson(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${req.params.recommendation_id}".`, traceparent);
        const data = await r.json();
        data.metadata.retrieved_at = new Date().toISOString();
        res.status(200).json(data);
      })
      .catch(() => sendProblemJson(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${req.params.recommendation_id}".`, traceparent));
    return;
  }
  
  if (userRole !== 'ADMIN' && userRole !== 'AUDITOR' && local.ctx?.employeeId !== employeeId) {
    return sendProblemJson(res, 403, 'FORBIDDEN', 'You do not have permission to view this recommendation.', traceparent);
  }

  const responseBody = JSON.parse(JSON.stringify(local.body));
  responseBody.metadata.retrieved_at = new Date().toISOString();
  return res.status(200).json(responseBody);
});

app.get('/rates', (req, res) => {
  const feed = rateFeed.getFeed();
  const ps = rateFeed.getPolicyStore();
  const currencies = rateFeed.getFcnrCurrencies();
  res.status(200).json({
    policy_version: rateFeed.getPolicyVersion(),
    rates_as_of: rateFeed.getRatesAsOf(),
    provider: rateFeed.getProvider(),
    feed_status: rateFeed.isLive() ? 'live' : 'fallback',
    feed_error: rateFeed.getLastError(),
    nre_rates: [12, 24, 36, 48, 60].map((m) => ({ tenure_months: m, annual_rate_pct: ps.nre, effective_from: '2026-01-01' })),
    fcnr_rates: currencies.map((c) => ({ currency: c, tenures: [12, 24, 36, 48, 60].map((m) => ({ tenure_months: m, annual_rate_pct: ps.fcnr[c], effective_from: '2026-01-01' })) })),
    fx_spot_rates: feed.spot,
    fx_forward_rates: feed.forward,
    history_size: rateFeed.getHistory().length,
  });
});

app.get('/recent-suggestions', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  let items = listRecentOptimizations(limit);
  
  const employeeId = req.headers['x-employee-id'];
  const userRole = req.headers['x-user-role'];
  const filterEmpId = (userRole === 'ADMIN' || userRole === 'AUDITOR') ? req.query.employee_id : employeeId;
  
  if (filterEmpId) {
    items = items.filter(i => i.employee_id === filterEmpId);
  }
  
  res.status(200).json({ total: items.length, page: 1, limit, pages: 1, logs: items });
});

app.get('/logs', async (req, res) => {
  // Delegate to audit-service; fall back to local in-memory buffer.
  try {
    const query = new URLSearchParams(req.query).toString();
    const r = await safeFetch(`${config.services.auditUrl}/api/v1/audit/logs?${query}`, {}, { timeoutMs: 2000, retries: 1 });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    // Local fallback: list the in-memory ring buffer.
    const { page = 1, limit = 50, customer_id, product } = req.query;
    let logs = listRecentOptimizations(parseInt(limit, 10) * 2);
    if (customer_id) logs = logs.filter((l) => l.customer_id === customer_id);
    if (product) logs = logs.filter((l) => l.recommended_product === String(product).toUpperCase());
    const total = logs.length;
    const pn = Math.max(1, parseInt(page, 10));
    const lm = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const paginated = logs.slice((pn - 1) * lm, pn * lm);
    return res.status(200).json({ total, page: pn, limit: lm, pages: Math.ceil(total / lm), logs: paginated, source: 'local_fallback' });
  }
});

app.get('/reports/:recommendation_id', async (req, res) => {
  const traceparent = req.traceparent;
  let record = getRecentOptimization(req.params.recommendation_id);
  const employeeId = req.headers['x-employee-id'];
  const userRole = req.headers['x-user-role'];

  if (!record) {
    try {
      const r = await safeFetch(`${config.services.auditUrl}/api/v1/audit/recommendations/${encodeURIComponent(req.params.recommendation_id)}`, {
        headers: {
          'x-employee-id': employeeId,
          'x-user-role': userRole,
          'x-gateway-timestamp': req.headers['x-gateway-timestamp'],
          'x-internal-signature': req.headers['x-internal-signature']
        }
      }, { timeoutMs: 1500, retries: 1 });
      if (!r.ok) return sendProblemJson(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${req.params.recommendation_id}".`, traceparent);
      record = { body: await r.json() };
    } catch {
      return sendProblemJson(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${req.params.recommendation_id}".`, traceparent);
    }
  }

  const recEmployeeId = record.body?.employee_id || record.body?.metadata?.employee_id;
  if (userRole !== 'ADMIN' && userRole !== 'AUDITOR' && recEmployeeId !== employeeId && record.ctx?.employeeId !== employeeId) {
    return sendProblemJson(res, 403, 'FORBIDDEN', 'You do not have permission to view this report.', traceparent);
  }
  try {
    const pdfBuffer = await generatePdfReport(record.body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="yield-report-${req.params.recommendation_id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    log.error('pdf_gen_error', { error: err.message });
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate PDF report.', traceparent);
  }
});

app.get('/metrics', metricsHandler);

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'yield-engine' }));
app.get('/health/startup', (req, res) => {
  // Yield engine is "started" once rate feed has loaded (live or fallback).
  res.status(rateFeed.getFeed() ? 200 : 503).json({
    status: rateFeed.getFeed() ? 'started' : 'starting',
    service: 'yield-engine',
  });
});
app.get('/health/ready', async (req, res) => {
  const marketDataReady = rateFeed.isLive();
  const ready = marketDataReady && recentList.length >= 0;
  const checks = {
    rate_feed: { status: rateFeed.isLive() ? 'live' : 'fallback', provider: rateFeed.getProvider(), error: rateFeed.getLastError(), is_critical: true },
    policy_store: { status: 'ok' },
    audit_local_buffer: { status: 'ok', entries: recentList.length, capacity: RECENT_BUFFER_SIZE },
    audit_service: { status: 'unknown' },
  };
  try {
    const r = await safeFetch(`${config.services.auditUrl}/health/live`, {}, { timeoutMs: 1000, retries: 0 });
    checks.audit_service = { status: r.ok ? 'reachable' : 'degraded', is_critical: false };
  } catch {
    checks.audit_service = { status: 'unreachable', is_critical: false };
  }
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    service: 'yield-engine',
    uptime_seconds: process.uptime(),
    checks,
    version: JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../../package.json'))).version,
  });
});

app.use(errorHandler);

const PORT = config.port.yieldEngine;
server.listen(PORT, () => {
  log.info('yield_engine_listening', { port: PORT });
  rateFeed.start(config.rateUpdateIntervalMs);
});

// Graceful shutdown
function shutdown(signal) {
  log.info('yield_engine_shutdown_begin', { signal });
  rateFeed.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { error: err && err.message, stack: err && err.stack }));
process.on('uncaughtException', (err) => log.error('uncaught_exception', { error: err.message, stack: err.stack }));
