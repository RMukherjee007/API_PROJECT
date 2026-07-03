/**
 * Bank Integration Service.
 *
 * Narrow adapter for advisory-only portfolio enrichment. It exposes only the
 * customer asset/liability view needed by the recommendation engine.
 *
 * Runtime modes:
 *   - dev/sandbox: fetches mock CBS data through the ESB translation layer.
 *   - live: fetches normalized portfolio data from CBS_ADAPTER_URL.
 */

process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'bank-integration';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const config = require('../../shared/config');
const { logger, withCorrelation } = require('../../shared/logger');
const { correlationMiddleware, sendProblemJson, safeFetch, buildSignedRequestHeaders } = require('../../shared/utils/helpers');
const { requestLogger } = require('../../shared/middleware/logger');
const { errorHandler } = require('../../shared/middleware/errorHandler');
const { rateLimiter } = require('../../shared/middleware/rateLimiter');
const { authenticateRequest } = require('../../shared/middleware/auth');
const { metricsMiddleware, metricsHandler } = require('../../shared/metrics');

const log = withCorrelation('-');
log.info('bank_integration_boot', { port: config.port.bank, live: config.bank.liveMode });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.security.corsOrigins }));
app.use(compression());
app.use(express.json({
  limit: '512kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(correlationMiddleware);
app.use(metricsMiddleware());
app.use(requestLogger);
app.use(rateLimiter);
app.use('/api/v1/bank', authenticateRequest);

function normalizePortfolio(payload = {}) {
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const liabilities = Array.isArray(payload.liabilities) ? payload.liabilities : [];
  return {
    customer_id: payload.customer_id || payload.customerId,
    assets: assets.map((asset) => ({
      currency: String(asset.currency || '').toUpperCase(),
      asset_type: asset.asset_type || asset.assetType || 'OTHER',
      market_value: Number(asset.market_value ?? asset.marketValue ?? asset.value ?? 0).toFixed(2),
      source: asset.source || (config.bank.liveMode ? 'CBS' : 'ESB_MOCK'),
      valuation_date: asset.valuation_date || asset.valuationDate || new Date().toISOString().slice(0, 10),
    })),
    liabilities: liabilities.map((liability) => ({
      currency: String(liability.currency || '').toUpperCase(),
      liability_type: liability.liability_type || liability.liabilityType || 'OTHER',
      outstanding_principal: Number(liability.outstanding_principal ?? liability.outstandingPrincipal ?? liability.value ?? 0).toFixed(2),
      source: liability.source || (config.bank.liveMode ? 'CBS' : 'ESB_MOCK'),
      valuation_date: liability.valuation_date || liability.valuationDate || new Date().toISOString().slice(0, 10),
    })),
    retrieved_at: new Date().toISOString(),
    mode: config.bank.liveMode ? 'live' : 'mock',
  };
}

async function fetchLivePortfolio(customerId) {
  const url = `${config.bank.cbsAdapterUrl.replace(/\/$/, '')}/portfolio/${encodeURIComponent(customerId)}`;
  const response = await safeFetch(url, {}, { timeoutMs: 5000, retries: 1 });
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { error: 'CBS JSON Parse Error', detail: 'Invalid JSON response from CBS' };
  }
  if (!response.ok) {
    // Mask potential raw stack traces or internal network info from third-party APIs
    return { 
      error: `CBS adapter returned HTTP ${response.status}`, 
      detail: 'Upstream CBS adapter responded with an error.' 
    };
  }
  return normalizePortfolio({ ...payload, customer_id: payload.customer_id || customerId });
}

async function fetchEsbPortfolio(customerId) {
  const url = `${config.services.esbUrl}/portfolio/${encodeURIComponent(customerId)}`;
  const response = await safeFetch(url, {
    headers: buildSignedRequestHeaders({
      secret: config.security.hmacSecret,
      method: 'GET',
      path: new URL(url).pathname,
      body: '',
      employeeId: 'BANK_INTEGRATION',
      userRole: 'SERVICE',
    }),
  }, { timeoutMs: 3000, retries: 1 });
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { error: 'ESB JSON Parse Error', detail: 'Invalid JSON response from ESB' };
  }
  if (!response.ok) {
    // Mask potential raw stack traces or internal network info from third-party APIs
    return { 
      error: `ESB returned HTTP ${response.status}`, 
      detail: 'Upstream ESB responded with an error.' 
    };
  }
  return normalizePortfolio({ ...payload, customer_id: payload.customer_id || customerId });
}

async function cbsFetchPortfolio(customerId) {
  if (config.bank.liveMode) return fetchLivePortfolio(customerId);
  return fetchEsbPortfolio(customerId);
}

app.get('/api/v1/bank/cbs/portfolio/:customerId', async (req, res) => {
  const customerId = req.params.customerId;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(customerId)) {
    return sendProblemJson(res, 400, 'INVALID_FORMAT', 'customerId must use letters, numbers, underscore, or hyphen.', req.traceparent);
  }
  const portfolio = await cbsFetchPortfolio(customerId);
  if (portfolio.error) return sendProblemJson(res, 502, 'DEPENDENCY_TIMEOUT', portfolio.error, req.traceparent);
  return res.status(200).json(portfolio);
});

app.get('/api/v1/bank/info', (req, res) => {
  res.status(200).json({
    service: 'bank-integration',
    mode: config.bank.liveMode ? 'live' : 'mock',
    capabilities: ['cbs_fetch_portfolio'],
    cbs_adapter: config.bank.cbsAdapterUrl || '(esb-mock)',
    version: require('../../../package.json').version,
  });
});

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'bank-integration' }));
app.get('/health/startup', (req, res) => res.status(200).json({ status: 'started', service: 'bank-integration' }));
app.get('/health/ready', (req, res) => res.status(200).json({
  status: config.bank.liveMode && !config.bank.cbsAdapterUrl ? 'degraded' : 'ready',
  service: 'bank-integration',
  uptime_seconds: process.uptime(),
  mode: config.bank.liveMode ? 'live' : 'mock',
  version: require('../../../package.json').version,
}));

app.get('/metrics', metricsHandler);
app.use(errorHandler);

const PORT = config.port.bank;
app.listen(PORT, () => log.info('bank_integration_listening', { port: PORT }));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('unhandledRejection', (err) => log.error('unhandled_rejection', { error: err && err.message }));
