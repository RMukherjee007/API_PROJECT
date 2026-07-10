/**
 * API Gateway — front door for the platform.
 *
 * Responsibilities:
 *   - HMAC + JWT authentication on every protected endpoint
 *   - Idempotency on POST /optimize
 *   - Redis-backed rate limiting per IP
 *   - Per-route caching for portfolio lookups (cache-aside on Redis)
 *   - W3C trace context propagation
 *   - Proxies to yield-engine, audit-service, bank-integration-service
 *
 * Endpoints:
 *   POST /optimize                          — main recommendation
 *   GET  /rates                             — proxy to yield-engine
 *   GET  /recent-suggestions                 — recent suggestion history
 *   GET  /logs                              — persisted suggestion logs
 *   GET  /recommendations/:id               — fetch one stored suggestion
 *   GET  /reports/:id                       — downloadable recommendation report
 *   POST /auth/login, /auth/refresh, /auth/logout, /auth/me, /auth/introspect
 *   GET  /metrics
 *   GET  /version
 *   GET  /health/{live,ready,startup}
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'gateway';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const config = require('../shared/config');
const { logger, withCorrelation } = require('../shared/logger');
const { correlationMiddleware, sendProblemJson, safeFetch, buildSignedRequestHeaders } = require('../shared/utils/helpers');
const { requestLogger } = require('../shared/middleware/logger');
const { errorHandler } = require('../shared/middleware/errorHandler');
const { rateLimiter, redis } = require('../shared/middleware/rateLimiter');
const { authenticateRequest, authenticateJwt, requireOverrideRole } = require('../shared/middleware/auth');
const { idempotencyCheck } = require('../shared/middleware/idempotency');
const { metricsMiddleware, metricsHandler } = require('../shared/metrics');

const log = withCorrelation('-');
log.info('gateway_boot', { port: config.port.gateway, env: config.env });

const inFlightCbsFetches = new Map();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: false, // SPA is served by the frontend service
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: config.security.corsOrigins, credentials: true }));
app.use(compression());
// Capture raw body for accurate HMAC signing.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(correlationMiddleware);
app.use(metricsMiddleware());
app.use(requestLogger);
app.use(rateLimiter);

// Per-route cache for portfolio lookups
async function getCachedPortfolio(customerId) {
  if (!redis) return null;
  try {
    const cached = await redis.get(`cbs_portfolio:${customerId}`);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    log.warn('cache_get_failed', { error: err.message });
    return null;
  }
}

async function setCachedPortfolio(customerId, data) {
  if (!redis || !data || data.error || typeof data !== 'object' || !Array.isArray(data.assets) || !Array.isArray(data.liabilities)) return;
  try {
    await redis.set(`cbs_portfolio:${customerId}`, JSON.stringify(data), 'EX', config.redis.cbsCacheTtlSeconds);
  } catch (err) {
    log.warn('cache_set_failed', { error: err.message });
  }
}

function signedServiceHeaders(req, { url, method = 'GET', body = '', headers = {}, employeeId, userRole } = {}) {
  const servicePath = new URL(url).pathname;
  return buildSignedRequestHeaders({
    secret: config.security.hmacSecret,
    method,
    path: servicePath,
    body,
    employeeId: employeeId || req.employeeId || 'GATEWAY',
    userRole: userRole || req.userRole || 'SERVICE',
    extraHeaders: {
      ...headers,
      traceparent: req.traceparent,
      'x-correlation-id': req.correlationId,
    },
  });
}

// Helpers to proxy with timeout + trace
async function proxyJson(res, url, init = {}) {
  const r = await safeFetch(url, init, { timeoutMs: 5000, retries: 1 });
  const text = await r.text();
  res.status(r.status);
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
  res.send(text);
}

async function proxyBinary(res, url, init = {}) {
  const r = await safeFetch(url, init, { timeoutMs: 10000, retries: 1 });
  const buf = Buffer.from(await r.arrayBuffer());
  res.status(r.status);
  for (const k of ['content-type', 'content-disposition']) {
    const v = r.headers.get(k);
    if (v) res.setHeader(k, v);
  }
  res.send(buf);
}

function appendRouteParams(pathPrefix, req) {
  if (!pathPrefix.endsWith('/')) return pathPrefix;
  const values = Object.values(req.params || {});
  if (values.length === 0) return pathPrefix;
  return `${pathPrefix}${values.map((value) => encodeURIComponent(value)).join('/')}`;
}

// === Auth proxy endpoints (mounted on /auth/*) ===
function authProxy(path, method = 'POST') {
  return async (req, res) => {
    try {
      const url = `${config.services.authUrl}${path}`;
      const headers = { 'content-type': 'application/json' };
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      if (req.correlationId) headers['x-correlation-id'] = req.correlationId;
      await proxyJson(res, url, { method, headers, body: method !== 'GET' ? JSON.stringify(req.body || {}) : undefined });
    } catch (err) {
      sendProblemJson(res, 503, 'DEPENDENCY_TIMEOUT', 'auth service unreachable', req.traceparent);
    }
  };
}

app.post('/auth/login', authProxy('/api/v1/auth/login', 'POST'));
app.post('/auth/refresh', authProxy('/api/v1/auth/refresh', 'POST'));
app.post('/auth/logout', authProxy('/api/v1/auth/logout', 'POST'));
app.post('/auth/introspect', authProxy('/api/v1/auth/introspect', 'POST'));
app.get('/auth/me', authProxy('/api/v1/auth/me', 'GET'));

// === Optimize ===
app.post('/optimize', authenticateRequest, authenticateJwt, requireOverrideRole, idempotencyCheck, async (req, res) => {
  const customerId = req.body.customer_id;
  const traceparent = req.traceparent;

  if (!customerId) {
    if (req.clearIdempotent) req.clearIdempotent();
    return sendProblemJson(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing customer_id.', traceparent, { customer_id: 'is required' });
  }

  let portfolioSource = 'CLIENT_INPUT';
  let portfolioData = { assets: req.body?.assets || [], liabilities: req.body?.liabilities || [] };

  if (portfolioData.assets.length === 0 && portfolioData.liabilities.length === 0) {
    try {
      const cachedPortfolio = await getCachedPortfolio(customerId);
      if (cachedPortfolio) {
        portfolioData = cachedPortfolio;
        portfolioSource = 'CACHE_HIT';
        log.info('cbs_cache_hit', { customerId });
      } else {
        // Try bank-integration-service (preferred), fall back to ESB.
        let upstreamOk = false;
        try {
          const url = `${config.services.bankUrl}/api/v1/bank/cbs/portfolio/${encodeURIComponent(customerId)}`;
          const r = await safeFetch(url, {
            headers: signedServiceHeaders(req, { url }),
          }, { timeoutMs: 3000, retries: 1 });
          if (r.ok) {
            const data = await r.json();
            portfolioData = { assets: data.assets || [], liabilities: data.liabilities || [] };
            portfolioSource = 'CBS_FETCH';
            upstreamOk = true;
          }
        } catch (err) {
          log.warn('bank_integration_unreachable_fallback_esb', { error: err.message });
        }
        if (!upstreamOk) {
          try {
            if (inFlightCbsFetches.has(customerId)) {
              portfolioData = await inFlightCbsFetches.get(customerId);
              portfolioSource = 'ESB_FETCH';
            } else {
              const fetchPromise = (async () => {
                const url = `${config.services.esbUrl}/portfolio/${encodeURIComponent(customerId)}`;
                const r = await safeFetch(url, {
                  headers: signedServiceHeaders(req, { url }),
                }, { timeoutMs: 3000, retries: 1 });
                if (r.ok) {
                  const data = await r.json();
                  return { assets: data.assets || [], liabilities: data.liabilities || [] };
                }
                throw new Error(`ESB fetch failed with status ${r.status}`);
              })();

              inFlightCbsFetches.set(customerId, fetchPromise);
              portfolioData = await fetchPromise;
              inFlightCbsFetches.delete(customerId);
              portfolioSource = 'ESB_FETCH';
              await setCachedPortfolio(customerId, portfolioData);
              log.info('cbs_cache_miss_esb_fetch', { customerId });
            }
          } catch (err) {
            inFlightCbsFetches.delete(customerId);
            portfolioSource = 'NOT_AVAILABLE';
            log.warn('esb_unreachable', { error: err.message });
            return sendProblemJson(res, 503, 'DEPENDENCY_TIMEOUT', 'Upstream CBS/ESB is unreachable.', req.traceparent);
          }
        }
      }
    } catch (err) {
      portfolioSource = 'NOT_AVAILABLE';
      log.error('portfolio_fetch_failed', { error: err.message });
    }
  }

  // Normalize
  if (portfolioData.assets) portfolioData.assets = portfolioData.assets.map((a) => ({ ...a, market_value: a.market_value !== undefined ? parseFloat(a.market_value).toFixed(2) : a.market_value }));
  if (portfolioData.liabilities) portfolioData.liabilities = portfolioData.liabilities.map((l) => ({ ...l, outstanding_principal: l.outstanding_principal !== undefined ? parseFloat(l.outstanding_principal).toFixed(2) : l.outstanding_principal }));

  const finalAssets = (req.body.assets && req.body.assets.length > 0) ? req.body.assets : portfolioData.assets;
  const finalLiabilities = (req.body.liabilities && req.body.liabilities.length > 0) ? req.body.liabilities : portfolioData.liabilities;
  const fatPayload = { ...req.body, ...portfolioData, assets: finalAssets, liabilities: finalLiabilities };
  const bodyString = JSON.stringify(fatPayload);
  const optimizeUrl = `${config.services.yieldEngineUrl}/optimize`;
  const headersToForward = signedServiceHeaders(req, {
    url: optimizeUrl,
    method: 'POST',
    body: bodyString,
    headers: {
      'Content-Type': 'application/json',
      'X-Portfolio-Source': portfolioSource,
    },
  });

  try {
    const r = await safeFetch(optimizeUrl, { method: 'POST', headers: headersToForward, body: bodyString }, { timeoutMs: 5000, retries: 1 });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    res.status(r.status);
    res.setHeader('X-Portfolio-Source', portfolioSource);
    if (r.ok) {
      if (req.storeIdempotentResponse) req.storeIdempotentResponse(data);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(data));
    } else {
      if (req.clearIdempotent) await req.clearIdempotent();
      res.setHeader('Content-Type', 'application/problem+json');
      res.send(JSON.stringify(data));
    }
  } catch (err) {
    log.error('yield_engine_unreachable', { error: err.message });
    if (req.clearIdempotent) req.clearIdempotent();
    return sendProblemJson(res, 503, 'DEPENDENCY_TIMEOUT', 'The yield computation microservice is unreachable.', traceparent);
  }
});

// === Minimal advisory proxies (require HMAC auth) ===
function proxy(path, target, method = 'GET', binary = false) {
  return async (req, res) => {
    try {
      const searchParams = new URLSearchParams(req.url.split('?')[1] || '');
      // Enforce IDOR protection: only let ADMIN or AUDITOR view other people's records.
      if (req.userRole !== 'ADMIN' && req.userRole !== 'AUDITOR' && req.employeeId) {
        searchParams.set('employee_id', req.employeeId);
      }
      const queryString = searchParams.toString();
      const targetPath = appendRouteParams(path, req);
      const url = `${target}${targetPath}${queryString ? '?' + queryString : ''}`;
      const headers = signedServiceHeaders(req, { url, method });
      if (binary) await proxyBinary(res, url, { method, headers });
      else await proxyJson(res, url, { method, headers });
    } catch (err) {
      sendProblemJson(res, 503, 'DEPENDENCY_TIMEOUT', 'Upstream unreachable', req.traceparent);
    }
  };
}

app.get('/rates', authenticateRequest, authenticateJwt, proxy('/rates', config.services.yieldEngineUrl));
app.get('/recent-suggestions', authenticateRequest, authenticateJwt, proxy('/recent-suggestions', config.services.yieldEngineUrl));
app.get('/logs', authenticateRequest, authenticateJwt, proxy('/api/v1/audit/logs', config.services.auditUrl));
app.get('/logs/pdf', authenticateRequest, authenticateJwt, proxy('/api/v1/audit/logs/pdf', config.services.auditUrl, 'GET', true));
app.get('/recommendations/:recommendation_id', authenticateRequest, authenticateJwt, proxy('/api/v1/audit/recommendations/', config.services.auditUrl));
app.get('/reports/:recommendation_id', authenticateRequest, authenticateJwt, proxy('/reports/', config.services.yieldEngineUrl, 'GET', true));

// === Metrics / version / health ===
app.get('/metrics', metricsHandler);
app.get('/version', (req, res) => res.status(200).json({
  service: 'gateway',
  version: require('../../package.json').version,
  build_time: process.env.BUILD_TIME || new Date().toISOString(),
  node: process.version,
  env: config.env,
}));

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'gateway' }));
app.get('/health/startup', (req, res) => res.status(200).json({ status: 'started', service: 'gateway' }));
app.get('/health/ready', async (req, res) => {
  const checks = { redis: { status: 'unknown' }, yield_engine: { status: 'unknown' }, audit: { status: 'unknown' }, auth: { status: 'unknown' } };
  let allReady = true;
  if (redis) {
    try { await redis.ping(); checks.redis = { status: 'connected', is_critical: false }; }
    catch { checks.redis = { status: 'disconnected', is_critical: false }; allReady = false; }
  } else { checks.redis = { status: 'disabled', is_critical: false }; }
  for (const [name, url] of [['yield_engine', config.services.yieldEngineUrl], ['audit', config.services.auditUrl], ['auth', config.services.authUrl]]) {
    try {
      const r = await safeFetch(`${url}/health/live`, {}, { timeoutMs: 1000, retries: 0 });
      checks[name] = { status: r.ok ? 'reachable' : 'degraded', is_critical: name === 'yield_engine' };
      if (!r.ok && name === 'yield_engine') allReady = false;
    } catch { checks[name] = { status: 'unreachable', is_critical: name === 'yield_engine' }; if (name === 'yield_engine') allReady = false; }
  }
  res.status(allReady ? 200 : 503).json({
    status: allReady ? 'ready' : 'degraded',
    service: 'gateway',
    uptime_seconds: process.uptime(),
    version: require('../../package.json').version,
    checks,
  });
});

app.use(errorHandler);

const PORT = config.port.gateway;
let server;
if (require.main === module) {
  server = app.listen(PORT, () => log.info('gateway_listening', { port: PORT }));
}
module.exports = app;

function shutdown(sig) {
  log.info('gateway_shutdown_begin', { signal: sig });
  if (redis) redis.quit().catch(() => { });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { error: err && err.message }));
process.on('uncaughtException', (err) => log.error('uncaught_exception', { error: err.message, stack: err.stack }));
process.on('uncaughtException', (err) => log.error('uncaught_exception', { error: err.message, stack: err.stack }));
