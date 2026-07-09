/**
 * Centralized configuration loader.
 *
 * - All env-vars are read here, validated, and exported as a typed shape.
 * - Fails fast on missing required production secrets.
 * - Computes derived values (e.g. MIN_PRINCIPAL_USD, RATE_LIMIT_RPS).
 */

require('dotenv').config();

function parseInt10(value, def) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : def;
}

function parseFloat10(value, def) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : def;
}

function parseBool(value, def = false) {
  if (value === undefined || value === null || value === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

for (const k of ['HMAC_SHARED_SECRET', 'JWT_SECRET']) {
  if (!process.env[k]) {
    throw new Error(`Missing required env var: ${k}`);
  }
}

function looksLikePlaceholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length < 32) return true;
  return [
    'change-me',
    'changeme',
    'replace-me',
    'placeholder',
    'jwt-secret',
    'secret-change-me',
    'in-production',
  ].some((fragment) => normalized.includes(fragment));
}

function requireProductionEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required production env var: ${name}`);
  }
  return process.env[name];
}

// In production, refuse to boot with demo, mock, or placeholder settings.
if (isProd) {
  for (const k of ['HMAC_SHARED_SECRET', 'JWT_SECRET']) {
    const value = requireProductionEnv(k);
    if (looksLikePlaceholderSecret(value)) {
      throw new Error(`Refusing to start in production with weak or placeholder ${k}. Set a high-entropy value via the bank secret manager.`);
    }
  }
  if (process.env.HMAC_SHARED_SECRET === process.env.JWT_SECRET) {
    throw new Error('Refusing to start in production with identical HMAC_SHARED_SECRET and JWT_SECRET.');
  }
  if (isProd && !process.env.MYSQL_HOST) {
    throw new Error('Refusing to start in production without MYSQL_HOST explicitly set.');
  }
  if (parseInt10(process.env.BCRYPT_ROUNDS, 10) < 12) {
    throw new Error('Refusing to start in production with BCRYPT_ROUNDS below 12.');
  }

  requireProductionEnv('CBS_ADAPTER_URL');
  requireProductionEnv('TMS_MARKET_DATA_URL');
}

const config = {
  env,
  isProd,
  serviceName: process.env.SERVICE_NAME || 'gateway',
  port: {
    gateway: parseInt10(process.env.GATEWAY_PORT, 8080),
    yieldEngine: parseInt10(process.env.YIELD_ENGINE_PORT, 8082),
    esb: parseInt10(process.env.ESB_PORT, 8081),
    frontend: parseInt10(process.env.FRONTEND_PORT, 3000),
    auth: parseInt10(process.env.AUTH_PORT, 8083),
    audit: parseInt10(process.env.AUDIT_PORT, 8084),
    bank: parseInt10(process.env.BANK_PORT, 8085),
  },
  services: {
    yieldEngineUrl: process.env.YIELD_ENGINE_URL || 'http://localhost:8082',
    esbUrl: process.env.ESB_URL || 'http://localhost:8081',
    authUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:8083',
    auditUrl: process.env.AUDIT_SERVICE_URL || 'http://localhost:8084',
    bankUrl: process.env.BANK_INTEGRATION_SERVICE_URL || 'http://localhost:8085',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    enabled: process.env.REDIS_ENABLED !== 'false',
    cbsCacheTtlSeconds: parseInt10(process.env.CBS_CACHE_TTL_SECONDS, 120),
    rateLimitTtlSeconds: parseInt10(process.env.RATE_LIMIT_TTL_SECONDS, 60),
    idempotencyTtlSeconds: parseInt10(process.env.IDEMPOTENCY_TTL_SECONDS, 24 * 3600),
  },
  security: {
    hmacSecret: process.env.HMAC_SHARED_SECRET,
    jwtSecret: process.env.JWT_SECRET,
    jwtIssuer: process.env.JWT_ISSUER || 'nri-yield-platform',
    jwtAudience: process.env.JWT_AUDIENCE || 'nri-yield-clients',
    jwtAccessTtlSeconds: parseInt10(process.env.JWT_ACCESS_TTL_SECONDS, 15 * 60),
    jwtRefreshTtlSeconds: parseInt10(process.env.JWT_REFRESH_TTL_SECONDS, 24 * 3600),
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimitWindowMs: parseInt10(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: parseInt10(process.env.RATE_LIMIT_MAX, 100),
    timestampSkewSeconds: parseInt10(process.env.TIMESTAMP_SKEW_SECONDS, 30),
    bcryptRounds: parseInt10(process.env.BCRYPT_ROUNDS, isProd ? 12 : 10),
  },
  auth: {
    // Basic auth logic remains as a placeholder for bank's IAM integration
  },
  log: {
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    auditRetentionDays: parseInt10(process.env.AUDIT_RETENTION_DAYS, 90),
  },
  logging: {
    file: process.env.LOG_FILE !== 'false',
    pretty: process.env.LOG_PRETTY === 'true',
  },
  rateUpdateIntervalMs: parseInt10(process.env.RATE_UPDATE_INTERVAL_MS, 60_000),
  fxFeed: {
    provider: 'bank-tms',
    tmsMarketDataUrl: process.env.TMS_MARKET_DATA_URL || 'http://placeholder-tms-api.local/api/rates',
    apiKey: process.env.FX_FEED_API_KEY || '',
    timeoutMs: parseInt10(process.env.FX_FEED_TIMEOUT_MS, 8000),
  },
  storage: {
    driver: 'mysql',
    mysql: {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt10(process.env.MYSQL_PORT, 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'csb_bank',
      connectionLimit: parseInt10(process.env.MYSQL_POOL_MAX, 20),
    },
  },
  bank: {
    cbsAdapterUrl: process.env.CBS_ADAPTER_URL || 'http://placeholder-cbs-api.local/api/portfolio',
  },
  business: {
    minPrincipalUsd: parseFloat10(process.env.MIN_PRINCIPAL_USD, 1000),
    maxTenureMonths: parseInt10(process.env.MAX_TENURE_MONTHS, 60),
    minTenureMonths: parseInt10(process.env.MIN_TENURE_MONTHS, 12),
    fcnrOverrideCapPct: parseFloat10(process.env.FCNR_OVERRIDE_CAP_PCT, 1.0),
    fwdOverrideCapPct: parseFloat10(process.env.FWD_OVERRIDE_CAP_PCT, 5.0),
    decisionThresholdPct: parseFloat10(process.env.DECISION_THRESHOLD_PCT, 0.15),
    almPenaltyMaxPct: parseFloat10(process.env.ALM_PENALTY_MAX_PCT, 0.35),
  },
  metrics: {
    enabled: process.env.METRICS_ENABLED !== 'false',
  },
  frontend: {
    // Browser calls the frontend BFF; only the server-side BFF signs gateway requests.
    publicApiBase: process.env.PUBLIC_API_BASE || 'http://localhost:8080',
  },
};

module.exports = config;
