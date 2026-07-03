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

const mysql = require('mysql2/promise');

const pool = mysql.createPool(config.storage.mysql);

async function initDb() {
  if (config.env === 'production') {
    log.info('esb_demo_seed_skipped');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id VARCHAR(255) NOT NULL,
        market_value DOUBLE NOT NULL,
        currency VARCHAR(255) NOT NULL,
        asset_type VARCHAR(255) NOT NULL,
        source VARCHAR(255),
        valuation_date VARCHAR(255),
        INDEX idx_assets_customer (customer_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS liabilities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id VARCHAR(255) NOT NULL,
        outstanding_principal DOUBLE NOT NULL,
        currency VARCHAR(255) NOT NULL,
        liability_type VARCHAR(255) NOT NULL,
        source VARCHAR(255),
        valuation_date VARCHAR(255),
        INDEX idx_liab_customer (customer_id)
      )
    `);

    const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM assets');
    if (row.c > 0) return;
    const seedAssets = [
      ['CUST123', 50000, 'USD', 'FIXED_DEPOSIT', 'CBS_CORE', '2026-06-01'],
      ['CUST123', 10000, 'GBP', 'SAVINGS_ACCOUNT', 'CBS_CORE', '2026-06-10'],
      ['CUST123', 5000000, 'INR', 'NRE_ACCOUNT', 'CBS_CORE', '2026-06-12'],
      ['CUST_RICH', 100000, 'USD', 'FCNR_ACCOUNT', 'CBS_CORE', '2026-06-05'],
      ['CUST_RICH', 5000000, 'INR', 'SAVINGS_ACCOUNT', 'CBS_CORE', '2026-06-05'],
      ['CUST_LEVERAGED', 2000, 'USD', 'SAVINGS_ACCOUNT', 'CBS_CORE', '2026-06-05'],
      ['CUST_DEMO', 25000, 'USD', 'FIXED_DEPOSIT', 'CBS_CORE', '2026-06-10'],
      ['CUST_DEMO', 50000, 'EUR', 'FCNR_ACCOUNT', 'CBS_CORE', '2026-06-10'],
    ];
    const seedLiab = [
      ['CUST123', 2000000, 'INR', 'HOME_LOAN', 'LOS', '2026-06-15'],
      ['CUST_LEVERAGED', 10000000, 'INR', 'OTHER', 'LOS', '2026-06-15'],
      ['CUST_LEVERAGED', 50000, 'USD', 'CREDIT_CARD_OUTSTANDING', 'LOS', '2026-06-15'],
    ];
    if (seedAssets.length > 0) {
      await pool.query(
        `INSERT INTO assets(customer_id, market_value, currency, asset_type, source, valuation_date) VALUES ?`, 
        [seedAssets]
      );
    }
    if (seedLiab.length > 0) {
      await pool.query(
        `INSERT INTO liabilities(customer_id, outstanding_principal, currency, liability_type, source, valuation_date) VALUES ?`, 
        [seedLiab]
      );
    }
    log.info('cbs_seeded', { assets: seedAssets.length, liabilities: seedLiab.length });
  } catch (err) {
    log.error('cbs_db_connection_failed', { error: err.message });
  }
}

initDb();

app.get('/portfolio/:customer_id', authenticateRequest, async (req, res) => {
  const cid = req.params.customer_id;
  if (cid === 'FAIL_CBS') return sendProblemJson(res, 503, 'CBS_UNREACHABLE', 'Legacy CBS is unreachable.', req.traceparent);

  try {
    const [assets] = await pool.query(`SELECT * FROM assets WHERE customer_id = ?`, [cid]);
    const [liabilities] = await pool.query(`SELECT * FROM liabilities WHERE customer_id = ?`, [cid]);
    res.status(200).json({
      source: 'ESB_FETCH',
      positions_injected: { asset_count: (assets || []).length, liability_count: (liabilities || []).length },
      assets: (assets || []).map((a) => ({ market_value: Number(a.market_value).toFixed(2), currency: a.currency, asset_type: a.asset_type, source: a.source, valuation_date: a.valuation_date })),
      liabilities: (liabilities || []).map((l) => ({ outstanding_principal: Number(l.outstanding_principal).toFixed(2), currency: l.currency, liability_type: l.liability_type, source: l.source, valuation_date: l.valuation_date })),
    });
  } catch (err) {
    const msg = config.isProd ? 'Failed to fetch portfolio from ESB database.' : err.message;
    return sendProblemJson(res, 500, 'INTERNAL_SERVER_ERROR', msg, req.traceparent);
  }
});

app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok', service: 'esb' }));
app.get('/health/startup', (req, res) => res.status(200).json({ status: 'started', service: 'esb' }));
app.get('/health/ready', (req, res) => res.status(200).json({ status: 'ready', service: 'esb', uptime_seconds: process.uptime(), version: require('../../package.json').version }));

app.get('/metrics', metricsHandler);

app.use(errorHandler);

const PORT = config.port.esb;
app.listen(PORT, () => log.info('esb_listening', { port: PORT }));

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
