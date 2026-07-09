/**
 * Live FX rate feed.
 * Adds:
 *  - Multi-provider fallback (config.fxFeed.provider/baseUrl).
 *  - Bounded in-memory ring buffer of rate snapshots for diagnostics.
 *  - Wires to Prometheus fx_feed_up gauge.
 *  - Optional provider API key via config.fxFeed.apiKey.
 */

const config = require('../../shared/config');
const { logger } = require('../../shared/logger');
const { metrics } = require('../../shared/metrics');

const PREMIUM_MAP = {
  USD: 0.01916, GBP: 0.01235, EUR: 0.01331, CAD: 0.01143, AUD: 0.01254,
  SGD: 0.01121, JPY: 0.01250, CHF: 0.01259, HKD: 0.01215, AED: 0.01627,
  SAR: 0.01527, QAR: 0.01569, OMR: 0.01517, BHD: 0.01531, KWD: 0.01572,
};



const POLICY_STORE = {
  fcnr: {
    USD: { '12': '5.20', '24': '5.00', '36': '4.80', '48': '4.60', '60': '4.50' },
    GBP: { '12': '4.80', '24': '4.60', '36': '4.40', '48': '4.30', '60': '4.20' },
    EUR: { '12': '3.50', '24': '3.30', '36': '3.10', '48': '3.00', '60': '2.90' },
    CAD: { '12': '4.10', '24': '3.90', '36': '3.70', '48': '3.50', '60': '3.40' },
    AUD: { '12': '4.60', '24': '4.40', '36': '4.20', '48': '4.00', '60': '3.90' },
    SGD: { '12': '3.20', '24': '3.00', '36': '2.80', '48': '2.60', '60': '2.50' },
    JPY: { '12': '0.80', '24': '0.75', '36': '0.70', '48': '0.65', '60': '0.60' },
    CHF: { '12': '1.20', '24': '1.10', '36': '1.00', '48': '0.90', '60': '0.80' },
    HKD: { '12': '3.90', '24': '3.70', '36': '3.50', '48': '3.40', '60': '3.30' },
    AED: { '12': '4.20', '24': '4.00', '36': '3.80', '48': '3.70', '60': '3.60' },
    SAR: { '12': '4.00', '24': '3.80', '36': '3.60', '48': '3.50', '60': '3.40' },
    QAR: { '12': '4.10', '24': '3.90', '36': '3.70', '48': '3.60', '60': '3.50' },
    OMR: { '12': '3.80', '24': '3.60', '36': '3.40', '48': '3.30', '60': '3.20' },
    BHD: { '12': '3.90', '24': '3.70', '36': '3.50', '48': '3.40', '60': '3.30' },
    KWD: { '12': '4.30', '24': '4.10', '36': '3.90', '48': '3.80', '60': '3.70' },
  },
  nre: { '12': '7.25', '24': '7.10', '36': '7.00', '48': '6.90', '60': '6.80' },
  almPenaltyPct: config.business.almPenaltyMaxPct,
};

const FCNR_ELIGIBLE_CURRENCIES = Object.keys(POLICY_STORE.fcnr);

function withTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(timeoutId) };
}

function fixedRate(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(decimals);
}

function normalizeForwardCurve(pair, rawForward, spot) {
  const curve = {};
  const ccy = pair.split('/')[0];
  const premium = PREMIUM_MAP[ccy] || 0.015;
  const spotVal = Number(spot);
  for (const tenure of ['12', '24', '36', '48', '60']) {
    const years = Number(tenure) / 12;
    const derivedForward = spotVal * (1 + premium * years);
    const value = rawForward?.[tenure] ?? rawForward?.[`${tenure}M`] ?? rawForward?.[`${tenure}m`] ?? derivedForward;
    const fixed = fixedRate(value);
    if (!fixed) throw new Error(`Invalid forward rate for ${pair} ${tenure}M`);
    curve[tenure] = fixed;
  }
  return curve;
}

function normalizeTmsPayload(data) {
  const spotSource = data?.spot || data?.spots || data?.fx_spot_rates;
  const forwardSource = data?.forward || data?.forwards || data?.fx_forward_rates;
  if (!spotSource || typeof spotSource !== 'object') {
    throw new Error('Bank TMS payload missing spot rate map');
  }
  const spot = {};
  const forward = {};
  for (const ccy of FCNR_ELIGIBLE_CURRENCIES) {
    const pair = `${ccy}/INR`;
    const value = spotSource[pair] ?? spotSource[ccy] ?? spotSource[`${ccy}INR`];
    const fixed = fixedRate(value);
    if (!fixed) throw new Error(`Bank TMS payload missing valid spot rate for ${pair}`);
    spot[pair] = fixed;
    forward[pair] = normalizeForwardCurve(pair, forwardSource?.[pair] || forwardSource?.[ccy] || {}, fixed);
  }
  return {
    spot,
    forward,
    ratesAsOf: data.rates_as_of || data.asOf || data.timestamp || new Date().toISOString(),
    provider: 'bank-tms',
  };
}

async function fetchJson(url, timeoutMs, headers = {}) {
  const { controller, clear } = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clear();
  }
}



async function fetchBankTmsRates() {
  const headers = config.fxFeed.apiKey ? { authorization: `Bearer ${config.fxFeed.apiKey}` } : {};
  const data = await fetchJson(config.fxFeed.tmsMarketDataUrl, config.fxFeed.timeoutMs, headers);
  return normalizeTmsPayload(data);
}

class LiveRateFeed {
  constructor() {
    this.feed = { spot: {}, forward: {} };
    this.history = []; // ring buffer of snapshots (used for time-series)
    this.maxHistory = 500;
    this.ratesAsOf = new Date().toISOString();
    this.live = false;
    this.policyStore = JSON.parse(JSON.stringify(POLICY_STORE));
    this.policyVersion = 'POL-2026-Q2';
    this._timeout = null;
    this.failCount = 0;
    this.lastError = null;
    this.provider = config.fxFeed.provider;
    metrics.fxFeedUp.set(0);
  }

  getFeed() {
    return {
      ...this.feed,
      is_stale: !this.live,
      rates_as_of: this.ratesAsOf
    };
  }
  getPolicyStore() { return this.policyStore; }
  getPolicyVersion() { return this.policyVersion; }
  getRatesAsOf() { return this.ratesAsOf; }
  getFcnrCurrencies() { return FCNR_ELIGIBLE_CURRENCIES; }
  isLive() { return this.live; }
  getLastError() { return this.lastError; }
  getProvider() { return this.provider; }
  getHistory() { return this.history; }

  _validateSnapshot(snapshot) {
    // Cannot validate the first snapshot or if the feed was previously down.
    if (!this.live || this.history.length === 0) {
      return null;
    }
    const previous = this.feed.spot;
    const current = snapshot.spot;
    const maxDeviation = 0.10; // 10% max change in one interval. Should be configurable.

    for (const pair in current) {
      if (previous[pair]) {
        const prevRate = parseFloat(previous[pair]);
        const currRate = parseFloat(current[pair]);
        const deviation = Math.abs(currRate - prevRate) / prevRate;
        if (deviation > maxDeviation) {
          return `Rate for ${pair} deviated by ${(deviation * 100).toFixed(2)}% which is over the ${(maxDeviation * 100)}% threshold.`;
        }
      }
    }
    return null; // All good
  }

  async fetchLiveRates() {
    try {
      const snapshot = await fetchBankTmsRates();

      let updated = 0;
      for (const [pair, rate] of Object.entries(snapshot.spot)) {
        if (this.feed.spot[pair] !== rate) {
          // NEW: Add a sanity check layer before accepting the new rate.
          const validationError = this._validateSnapshot(snapshot);
          if (validationError) {
            throw new Error(`Rate snapshot failed validation: ${validationError}`);
          }

          this.feed.spot[pair] = rate;
          updated++;
        }
      }
      this.feed.forward = snapshot.forward;
      this.ratesAsOf = snapshot.ratesAsOf;
      this.provider = snapshot.provider;
      this.live = true;
      this.lastError = null;
      this.failCount = 0;
      metrics.fxFeedUp.set(1);
      this._pushHistory();
      logger.info('fx_feed_live_update', { provider: this.provider, pairs_updated: updated, rates_as_of: this.ratesAsOf });
      this._scheduleNext(config.rateUpdateIntervalMs);
    } catch (err) {
      this.live = false;
      this.lastError = err.message;
      this.failCount++;
      metrics.fxFeedUp.set(0);
      logger.warn('fx_feed_using_fallback', { provider: config.fxFeed.provider, error: err.message });
      const backoffMs = Math.min(config.rateUpdateIntervalMs * Math.pow(2, this.failCount), 15 * 60 * 1000);
      this._scheduleNext(backoffMs);
    }
  }

  _pushHistory() {
    this.history.push({ at: this.ratesAsOf, spot: { ...this.feed.spot } });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  _scheduleNext(delay) {
    if (this._timeout) clearTimeout(this._timeout);
    this._timeout = setTimeout(() => this.fetchLiveRates(), delay);
    this._timeout.unref();
  }

  start(intervalMs = config.rateUpdateIntervalMs) {
    this.failCount = 0;
    this.fetchLiveRates();
  }

  stop() {
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
  }
}

module.exports = { LiveRateFeed, POLICY_STORE, FCNR_ELIGIBLE_CURRENCIES, PREMIUM_MAP };
