/**
 * Enterprise Service Bus (ESB) — CBS protocol translation.
 *
 * In production, this is the layer that translates between our advisory
 * platform and the bank's Core Banking System (CBS). In dev mode it serves
 * the SQLite mock. Endpoints:
 *
 *   GET /portfolio/:customer_id       — positions + liabilities
 *   GET /health/{live,ready,startup}
 *   GET /metrics
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'esb';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const config = require('../shared/config');
const { logger, withCorrelation } = require('../shared/logger');
const { correlationMiddleware, sendProblemJson } = require('../shared/utils/helpers');
const { requestLogger } = require('../shared/middleware/logger');
const { errorHandler } = require('../shared/middleware/errorHandler');
const { rateLimiter } = require('../shared/middleware/rateLimiter');
const { authenticateRequest } = require('../shared/middleware/auth');
const { metricsMiddleware, metricsHandler } = require('../shared/metrics');

const log = withCorrelation('-');
log.info('esb_boot', { port: config.port.esb });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
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

const Redis = require('ioredis');
const redis = new Redis(config.redis.url);

app.get('/portfolio/:customer_id', authenticateRequest, async (req, res) => {
  const cid = req.params.customer_id;
  const traceparent = req.traceparent;

  // CRITICAL: Add input validation to prevent cache poisoning and other injection attacks.
  // This should be consistent with the validation in the bank-integration-service.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cid)) {
    return sendProblemJson(res, 400, 'INVALID_FORMAT', 'customerId must use letters, numbers, underscore, or hyphen.', req.traceparent);
  }

  try {
    // Check Redis Cache
    const cacheKey = `cbs_portfolio_cache:${cid}`;
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      log.info('cbs_portfolio_cache_hit', { customer_id: cid });
      return res.status(200).json(JSON.parse(cachedData));
    }

    // Cache miss - Fetch from real CBS adapter placeholder endpoint
    // Fallback URL if CBS_ADAPTER_URL is not yet configured by the bank
    const cbsUrl = config.bank.cbsAdapterUrl || 'http://placeholder-cbs-api.local/api/portfolio';
    const upstreamUrl = `${cbsUrl.replace(/\/$/, '')}/${encodeURIComponent(cid)}`;

    // In a real scenario, this would use safeFetch or axios to hit upstreamUrl.
    // For now, since the actual CBS endpoint might not exist during integration testing, 
    // we return a 501 Not Implemented or simulated fetch logic as per the user's placeholder requirement.

    // Placeholder payload mimicking expected structure for the bank to replace
    const placeholderPayload = {
      source: 'CBS_PROXY',
      customer_id: cid,
      assets: [],
      liabilities: []
    };

    // Cache payload for 120 seconds
    await redis.setex(cacheKey, 120, JSON.stringify(placeholderPayload));

    res.status(200).json(placeholderPayload);
  } catch (err) {
    const msg = config.isProd ? 'Failed to fetch portfolio from CBS.' : err.message;
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', msg, req.traceparent);
  }
});

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'esb' }));
app.get('/health/startup', (req, res) => res.status(200).json({ status: 'started', service: 'esb' }));
app.get('/health/ready', async (req, res) => {
  try {
    await redis.ping();
    res.status(200).json({ status: 'ready', service: 'esb', uptime_seconds: process.uptime(), version: require('../../package.json').version, checks: { redis: 'ok' } });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'esb', checks: { redis: 'unreachable' } });
  }
});

app.get('/metrics', metricsHandler);

app.use(errorHandler);

const PORT = config.port.esb;
if (require.main === module) {
  app.listen(PORT, () => log.info('esb_listening', { port: PORT }));
}
module.exports = { app, redis };

function shutdown(signal) {
  log.info('esb_shutdown_begin', { signal });
  // The quit() command returns a promise. We add a catch to prevent unhandled rejections
  // if Redis is already unavailable during shutdown.
  redis.quit().catch(() => { }).then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
