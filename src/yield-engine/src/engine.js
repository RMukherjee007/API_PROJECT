/**
 * Yield Advisory Math Engine.
 *
 * Phase 1: nominal rates from policy / overrides.
 * Phase 2: FX-adjust NRE if base_currency != INR, using spot & forward.
 * Phase 3: ALM penalty from portfolio (mismatch ratio). Applied to FCNR ONLY.
 * Phase 4: Fisher / PPP real-yield adjustment if inflation rates supplied.
 * Phase 5: Decision matrix (FCNR / NRE / EQUAL_YIELD) with configurable threshold.
 */

const { randomUUID } = require('crypto');
const Decimal = require('decimal.js');
const { formatCurrency } = require('../../shared/utils/helpers');
const config = require('../../shared/config');
const { AlmPolicyEngine } = require('./almPolicyEngine');

const POLICY_VERSION = 'POL-2026-Q2';
const FCNR_ELIGIBLE_CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'JPY', 'CHF', 'HKD', 'AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD'];
const GCC_CURRENCIES = ['AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD'];
const DEPOSIT_BASE_CURRENCIES = [...FCNR_ELIGIBLE_CURRENCIES, 'INR'];
const POSITION_CURRENCIES = DEPOSIT_BASE_CURRENCIES;
const ASSET_TYPES = ['FIXED_DEPOSIT', 'NRE_ACCOUNT', 'FCNR_ACCOUNT', 'SAVINGS_ACCOUNT', 'MUTUAL_FUND', 'EQUITY', 'OTHER'];
const LIABILITY_TYPES = ['HOME_LOAN', 'LOAN_AGAINST_PROPERTY', 'CAR_LOAN', 'PERSONAL_LOAN', 'CREDIT_CARD_OUTSTANDING', 'OTHER'];
const LIABILITY_WEIGHTS = { HOME_LOAN: 0.5, LOAN_AGAINST_PROPERTY: 0.7, CAR_LOAN: 0.8, PERSONAL_LOAN: 1.2, CREDIT_CARD_OUTSTANDING: 1.5, OTHER: 1.0 };
const CHANNELS = ['BRANCH', 'INTERNET_BANKING', 'MOBILE_APP', 'RM_PORTAL'];
const RISK_PROFILES = ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'];

const DECIMAL_2DP = /^\d+\.\d{2}$/;
const PCT_PATTERN = /^-?\d+\.\d{2,4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_GENERIC = /^\d+\.\d{2,6}$/;

function calculateRealYield(nominalYieldPct, inflationPct) {
  const nominal = new Decimal(nominalYieldPct).div(100);
  const inflation = new Decimal(inflationPct).div(100);
  return nominal.plus(1).div(inflation.plus(1)).minus(1).times(100).toNumber();
}

function resolveYieldCurveRate(curve, tenureMonths) {
  if (typeof curve === 'string' || typeof curve === 'number') return parseFloat(curve);
  if (!curve) return 0.00;
  const buckets = Object.keys(curve).map(Number).sort((a, b) => a - b);
  let selectedBucket = buckets[0];
  for (const bucket of buckets) {
    if (tenureMonths >= bucket) selectedBucket = bucket;
  }
  return parseFloat(curve[String(selectedBucket)] || '0.00');
}

function calculateMaturityMultiplier(ratePct, tenureMonths) {
  const r = new Decimal(ratePct).div(100);
  const T = new Decimal(tenureMonths).div(12);
  if (tenureMonths < 12) {
    return new Decimal(1).plus(r.times(T)).toNumber();
  }
  const n = new Decimal(4);
  const exponent = n.times(T).toNumber(); // pow accepts numbers
  return new Decimal(1).plus(r.div(n)).pow(exponent).toNumber();
}

function validateOptimizeRequest(body, traceparent, rateFeed) {
  const invalidFields = {};
  const required = ['customer_id', 'risk_profile', 'principal_amount', 'base_currency', 'value_date', 'tenure_months', 'channel'];

  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === '') invalidFields[field] = 'is required';
  }
  if (Object.keys(invalidFields).length > 0) {
    return { status: 400, errorCode: 'MISSING_REQUIRED_FIELD', detail: 'One or more required fields are missing.', invalidFields };
  }

  if (!RISK_PROFILES.includes(body.risk_profile)) invalidFields.risk_profile = `must be one of: ${RISK_PROFILES.join(', ')}`;
  if (!CHANNELS.includes(body.channel)) invalidFields.channel = `must be one of: ${CHANNELS.join(', ')}`;
  if (typeof body.customer_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.customer_id)) invalidFields.customer_id = 'must match ^[A-Za-z0-9_-]+$';
  if (typeof body.principal_amount !== 'string' || !DECIMAL_2DP.test(body.principal_amount)) invalidFields.principal_amount = 'must be a decimal string with exactly 2 decimal places, e.g. "1000000.00"';
  if (typeof body.value_date !== 'string' || !DATE_PATTERN.test(body.value_date)) invalidFields.value_date = 'must be in YYYY-MM-DD format';
  if (body.india_inflation_rate !== undefined && (typeof body.india_inflation_rate !== 'string' || !PCT_PATTERN.test(body.india_inflation_rate))) invalidFields.india_inflation_rate = 'must match ^-?\\d+\\.\\d{2,4}$';
  if (body.foreign_inflation_rate !== undefined && (typeof body.foreign_inflation_rate !== 'string' || !PCT_PATTERN.test(body.foreign_inflation_rate))) invalidFields.foreign_inflation_rate = 'must match ^-?\\d+\\.\\d{2,4}$';
  if (Object.keys(invalidFields).length > 0) {
    return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'One or more fields failed format validation.', invalidFields };
  }

  if (['BRANCH', 'RM_PORTAL'].includes(body.channel) && !body.branch_code) {
    return { status: 400, errorCode: 'MISSING_REQUIRED_FIELD', detail: 'branch_code is required when channel is BRANCH or RM_PORTAL.', invalidFields: { branch_code: 'is required for this channel' } };
  }
  if (body.branch_code && (typeof body.branch_code !== 'string' || !/^[A-Za-z0-9-]+$/.test(body.branch_code))) {
    return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'branch_code must match ^[A-Za-z0-9-]+$', invalidFields: { branch_code: 'must match ^[A-Za-z0-9-]+$' } };
  }

  if (body.is_manual_override === true) {
    const overrideFields = ['override_reason', 'approved_by', 'approval_timestamp', 'override_ticket_id'];
    const missing = overrideFields.filter((f) => !body[f]);
    if (missing.length > 0) {
      const fields = {};
      missing.forEach((f) => { fields[f] = 'is required when is_manual_override is true'; });
      return { status: 400, errorCode: 'MISSING_REQUIRED_FIELD', detail: 'Manual override fields are incomplete.', invalidFields: fields };
    }
    if (!body.override_reason || body.override_reason.trim() === '') {
      return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'override_reason cannot be empty.', invalidFields: { override_reason: 'cannot be empty' } };
    }
    if (typeof body.approved_by !== 'string' || !/^[A-Za-z0-9-]+$/.test(body.approved_by)) {
      return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'approved_by must match ^[A-Za-z0-9-]+$', invalidFields: { approved_by: 'must match ^[A-Za-z0-9-]+$' } };
    }
    if (typeof body.override_ticket_id !== 'string' || !/^[A-Za-z0-9-]+$/.test(body.override_ticket_id)) {
      return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'override_ticket_id must match ^[A-Za-z0-9-]+$', invalidFields: { override_ticket_id: 'must match ^[A-Za-z0-9-]+$' } };
    }
    const approvalTime = new Date(body.approval_timestamp).getTime();
    if (Number.isNaN(approvalTime) || approvalTime > Date.now()) {
      return { status: 422, errorCode: 'FUTURE_APPROVAL_TIMESTAMP', detail: 'approval_timestamp must not be in the future.', invalidFields: { approval_timestamp: 'must not be in the future' } };
    }
  }

  if (!DEPOSIT_BASE_CURRENCIES.includes(body.base_currency)) {
    return { status: 422, errorCode: 'INVALID_CURRENCY', detail: `base_currency "${body.base_currency}" is not supported.`, invalidFields: { base_currency: `must be one of: ${DEPOSIT_BASE_CURRENCIES.join(', ')}` } };
  }

  const tenure = Number(body.tenure_months);
  if (!Number.isInteger(tenure) || tenure < config.business.minTenureMonths || tenure > config.business.maxTenureMonths) {
    return { status: 422, errorCode: 'TENURE_OUT_OF_RANGE', detail: `tenure_months must be an integer between ${config.business.minTenureMonths} and ${config.business.maxTenureMonths}.`, invalidFields: { tenure_months: `must be between ${config.business.minTenureMonths} and ${config.business.maxTenureMonths}` } };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (body.value_date < today) {
    return { status: 422, errorCode: 'VALUE_DATE_IN_PAST', detail: 'value_date must not be before the current date.', invalidFields: { value_date: 'must not be in the past' } };
  }

  if (GCC_CURRENCIES.includes(body.base_currency)) {
    const branch = body.branch_code || '';
    if (!branch.toUpperCase().startsWith('GIFT')) {
      return { status: 422, errorCode: 'GCC_REQUIRES_IFSC_BRANCH', detail: 'GCC currency deposits require an IFSC (GIFT City) branch code.', invalidFields: { branch_code: 'must belong to an IFSC unit when base_currency is a GCC currency' } };
    }
  }

  // NEW: Principal minimum check (FCNR(B) RBI minimum is USD 1,000 equivalent).
  if (body.base_currency !== 'INR') {
    const principal = new Decimal(body.principal_amount);
    let principalUsd = principal;
    try {
      const feed = rateFeed.getFeed();
      if (body.base_currency !== 'USD') {
        const usdInr = parseFloat(feed.spot['USD/INR']);
        const ccyInr = parseFloat(feed.spot[`${body.base_currency}/INR`] || feed.spot[`USD/${body.base_currency}`]);
        if (usdInr && ccyInr) principalUsd = principal.times(ccyInr).div(usdInr);
        else principalUsd = NaN; // Force failure if rates are missing
      }
      // Explicitly check for NaN to prevent bypass on feed error
      if (Number.isNaN(principalUsd) || (principalUsd instanceof Decimal && principalUsd.isNaN())) throw new Error('Could not convert principal to USD due to missing FX rates.');
      if ((principalUsd instanceof Decimal ? principalUsd.toNumber() : principalUsd) < config.business.minPrincipalUsd) {
        return {
          status: 422,
          errorCode: 'PRINCIPAL_BELOW_MINIMUM',
          detail: `Principal ${body.principal_amount} ${body.base_currency} is below FCNR(B) minimum (USD ${config.business.minPrincipalUsd} equivalent).`,
          invalidFields: { principal_amount: `must be >= USD ${config.business.minPrincipalUsd} equivalent` },
        };
      }
    } catch (err) {
      // FAIL-CLOSED: If we cannot verify the principal amount due to a feed error, reject the request.
      return {
        status: 503,
        errorCode: 'RATE_FEED_UNAVAILABLE',
        detail: 'Market rate feed is down, cannot verify principal minimums. Please try again later.',
      };
    }
  }

  const feed = rateFeed.getFeed();
  if (body.assets && !Array.isArray(body.assets)) return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'assets must be an array.', invalidFields: { assets: 'must be an array' } };
  if (body.liabilities && !Array.isArray(body.liabilities)) return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'liabilities must be an array.', invalidFields: { liabilities: 'must be an array' } };

  for (const [idx, a] of (body.assets || []).entries()) {
    if (!POSITION_CURRENCIES.includes(a.currency)) return { status: 422, errorCode: 'INVALID_CURRENCY', detail: `assets[${idx}].currency not supported.`, invalidFields: { [`assets[${idx}].currency`]: 'unsupported currency' } };
    if (!ASSET_TYPES.includes(a.asset_type)) return { status: 422, errorCode: 'INVALID_FORMAT', detail: `assets[${idx}].asset_type invalid.`, invalidFields: { [`assets[${idx}].asset_type`]: `must be one of: ${ASSET_TYPES.join(', ')}` } };
    if (!a.market_value || typeof a.market_value !== 'string' || !DECIMAL_2DP.test(a.market_value)) return { status: 422, errorCode: 'INVALID_FORMAT', detail: `assets[${idx}].market_value must be a string with 2 decimal places.`, invalidFields: { [`assets[${idx}].market_value`]: 'must match ^\\d+\\.\\d{2}$' } };
  }
  for (const [idx, l] of (body.liabilities || []).entries()) {
    if (!POSITION_CURRENCIES.includes(l.currency)) return { status: 422, errorCode: 'INVALID_CURRENCY', detail: `liabilities[${idx}].currency not supported.`, invalidFields: { [`liabilities[${idx}].currency`]: 'unsupported currency' } };
    if (!LIABILITY_TYPES.includes(l.liability_type)) return { status: 422, errorCode: 'INVALID_FORMAT', detail: `liabilities[${idx}].liability_type invalid.`, invalidFields: { [`liabilities[${idx}].liability_type`]: `must be one of: ${LIABILITY_TYPES.join(', ')}` } };
    if (!l.outstanding_principal || typeof l.outstanding_principal !== 'string' || !DECIMAL_2DP.test(l.outstanding_principal)) return { status: 422, errorCode: 'INVALID_FORMAT', detail: `liabilities[${idx}].outstanding_principal must be a string with 2 decimal places.`, invalidFields: { [`liabilities[${idx}].outstanding_principal`]: 'must match ^\\d+\\.\\d{2}$' } };
  }

  if (body.fx_rate_overrides) {
    if (body.fx_rate_overrides.forward_rates && body.base_currency !== 'INR') {
      const pair = `${body.base_currency}/INR`;
      for (const tenureKey of Object.keys(body.fx_rate_overrides.forward_rates)) {
        const liveFwd = new Decimal(feed.forward[pair]?.[tenureKey] || feed.spot[pair]);
        const overrideFwd = new Decimal(body.fx_rate_overrides.forward_rates[tenureKey]);
        const deviation = overrideFwd.minus(liveFwd).abs().div(liveFwd).times(100).toNumber();
        if (deviation > config.business.fwdOverrideCapPct) {
          return { status: 422, errorCode: 'RATE_OVERRIDE_LIMIT_EXCEEDED', detail: `Forward rate override deviates ${deviation.toFixed(2)}% from market. Max allowed: ${config.business.fwdOverrideCapPct}%.`, invalidFields: { [`fx_rate_overrides.forward_rates.${tenureKey}`]: `deviation exceeds ${config.business.fwdOverrideCapPct}% limit` } };
        }
      }
    }
    if (body.fx_rate_overrides.product_spot_rate && body.base_currency !== 'INR') {
      const pair = `${body.base_currency}/INR`;
      const liveSpot = new Decimal(feed.spot[pair] || NaN);
      const overrideSpot = new Decimal(body.fx_rate_overrides.product_spot_rate);
      if (!liveSpot.isNaN() && !overrideSpot.isNaN()) {
        const deviation = overrideSpot.minus(liveSpot).abs().div(liveSpot).times(100).toNumber();
        if (deviation > config.business.fwdOverrideCapPct) {
          return { status: 422, errorCode: 'RATE_OVERRIDE_LIMIT_EXCEEDED', detail: `Spot rate override deviates ${deviation.toFixed(2)}% from market. Max allowed: ${config.business.fwdOverrideCapPct}%.`, invalidFields: { 'fx_rate_overrides.product_spot_rate': `deviation exceeds ${config.business.fwdOverrideCapPct}% limit` } };
        }
      }
    }
  }

  if (body.market_rates_override && body.market_rates_override.fcnr_rate_pct !== undefined) {
    const baseCurve = rateFeed.getPolicyStore().fcnr[body.base_currency];
    const baseRatePct = resolveYieldCurveRate(baseCurve, Number(body.tenure_months));
    const baseRate = new Decimal(baseRatePct);
    const overrideRate = new Decimal(body.market_rates_override.fcnr_rate_pct);
    const deviation = overrideRate.minus(baseRate).abs().toNumber();
    if (deviation > config.business.fcnrOverrideCapPct) {
      return { status: 422, errorCode: 'RATE_OVERRIDE_LIMIT_EXCEEDED', detail: `FCNR rate override deviates ${deviation.toFixed(2)}% from policy. Max allowed: ${config.business.fcnrOverrideCapPct}%.`, invalidFields: { 'market_rates_override.fcnr_rate_pct': `deviation exceeds ${config.business.fcnrOverrideCapPct}% limit` } };
    }
  }

  return null;
}

function computeYield(body, ctx) {
  const startedAt = Date.now();
  const { rateFeed, portfolioSource, userRole, employeeId, traceparent } = ctx;
  const { customer_id, risk_profile, principal_amount, base_currency, value_date, tenure_months, india_inflation_rate, foreign_inflation_rate, fx_rate_overrides, market_rates_override, assets = [], liabilities = [] } = body;

  // BEST PRACTICE: For financial calculations, avoid using native floating-point arithmetic
  // due to potential precision errors. Use a library like 'decimal.js' or handle money
  // as integers (e.g., in cents).
  // Example: const { Decimal } = require('decimal.js');
  // const principal = new Decimal(principal_amount);
  const feed = rateFeed.getFeed();
  const policyStore = rateFeed.getPolicyStore();
  const principal = new Decimal(principal_amount);

  let usdEquivalent = principal;
  if (base_currency !== 'USD') {
    let principalInr = principal;
    if (base_currency !== 'INR') principalInr = principal.times(feed.spot[`${base_currency}/INR`] || NaN);
    usdEquivalent = principalInr.div(feed.spot['USD/INR'] || NaN);
  }

  let fcnrNominalPct = resolveYieldCurveRate(policyStore.fcnr[base_currency], tenure_months);
  let nreNominalPct = resolveYieldCurveRate(policyStore.nre, tenure_months);
  let ratesSource = base_currency === 'INR' ? 'POLICY_STORE' : 'LIVE_MARKET_API';

  if (market_rates_override) {
    if (market_rates_override.fcnr_rate_pct !== undefined) fcnrNominalPct = parseFloat(market_rates_override.fcnr_rate_pct);
    if (market_rates_override.nre_rate_pct !== undefined) nreNominalPct = parseFloat(market_rates_override.nre_rate_pct);
    ratesSource = 'RM_OVERRIDE';
  } else if (fx_rate_overrides) {
    ratesSource = 'RM_INPUT';
  }

  const T = tenure_months / 12;
  let productSpotRate = null;
  let productForwardRate = null;
  let nreEffectiveYieldPct = nreNominalPct;

  if (base_currency !== 'INR') {
    const pair = `${base_currency}/INR`;
    productSpotRate = fx_rate_overrides?.product_spot_rate ? new Decimal(fx_rate_overrides.product_spot_rate) : new Decimal(feed.spot[pair] || NaN);

    const tenureKey = String(tenure_months);
    let forwardFromFeed = feed.forward[pair]?.[tenureKey];
    if (forwardFromFeed === undefined && !fx_rate_overrides?.forward_rates?.[tenureKey]) {
      throw new Error(`Insufficient forward rate granularity. No cached forward rate available for exactly ${tenure_months} months.`);
    }
    productForwardRate = fx_rate_overrides?.forward_rates?.[tenureKey] ? new Decimal(fx_rate_overrides.forward_rates[tenureKey]) : new Decimal(forwardFromFeed);

    const nreMultiplier = new Decimal(calculateMaturityMultiplier(nreNominalPct, tenure_months));
    const usdReturnFactor = nreMultiplier.times(productSpotRate).div(productForwardRate);
    nreEffectiveYieldPct = usdReturnFactor.pow(1 / T).minus(1).times(100).toNumber();
    
    productSpotRate = productSpotRate.toNumber();
    productForwardRate = productForwardRate.toNumber();
  }

  let totalAssetsInr = new Decimal(0), totalLiabilitiesInr = new Decimal(0), weightedBankAssetsInr = new Decimal(0);
  const portfolioFxMatrix = {};

  for (const asset of assets) {
    const val = new Decimal(asset.market_value);
    if (asset.currency === 'INR') { totalAssetsInr = totalAssetsInr.plus(val); continue; }
    const pair = `${asset.currency}/INR`;
    let rate = new Decimal(feed.spot[pair] || NaN);
    if (fx_rate_overrides?.portfolio_cross_rates?.[pair]) rate = new Decimal(fx_rate_overrides.portfolio_cross_rates[pair]);
    if (rate.isNaN()) throw new Error(`Missing market rate for currency pair: ${pair}`);
    portfolioFxMatrix[pair] = rate.toFixed(6);
    totalAssetsInr = totalAssetsInr.plus(val.times(rate));
  }

  for (const liab of liabilities) {
    const val = new Decimal(liab.outstanding_principal);
    const weight = new Decimal(LIABILITY_WEIGHTS[liab.liability_type] || 1.0);
    let valInr = val;
    if (liab.currency !== 'INR') {
      const pair = `${liab.currency}/INR`;
      let rate = new Decimal(feed.spot[pair] || NaN);
      if (fx_rate_overrides?.portfolio_cross_rates?.[pair]) rate = new Decimal(fx_rate_overrides.portfolio_cross_rates[pair]);
      if (rate.isNaN()) throw new Error(`Missing market rate for currency pair: ${pair}`);
      portfolioFxMatrix[pair] = rate.toFixed(6);
      valInr = val.times(rate);
    }
    liab.outstanding_principal_inr = valInr.toNumber(); // Required field for ALM engine
    totalLiabilitiesInr = totalLiabilitiesInr.plus(valInr);
    weightedBankAssetsInr = weightedBankAssetsInr.plus(valInr.times(weight));
  }

  const portfolioAvailable = portfolioSource !== 'NOT_AVAILABLE';
  let principalInr = principal;
  if (base_currency !== 'INR') {
    const rate = new Decimal(portfolioFxMatrix[`${base_currency}/INR`] || feed.spot[`${base_currency}/INR`] || NaN);
    if (rate.isNaN()) throw new Error(`Missing market rate for currency pair: ${base_currency}/INR`);
    principalInr = principal.times(rate);
  }

  const clientAssetsForRatio = totalAssetsInr.plus(principalInr);
  const debtToAssetRatio = clientAssetsForRatio.gt(0) ? totalLiabilitiesInr.div(clientAssetsForRatio).toNumber() : 0;

  let almPenaltyApplied = false, almPenaltyPct = 0, almPenaltyAmount = 0;
  if (portfolioAvailable) {
    almPenaltyPct = AlmPolicyEngine.calculatePenalty({
      liabilities: body.liabilities || [],
      totalLiabilitiesInr,
      totalAssetsInr,
      principalInr,
      tenureMonths: tenure_months,
      basePenaltyPct: new Decimal(policyStore.almPenaltyPct || '0.25')
    });
    if (almPenaltyPct > 0) {
      almPenaltyApplied = true;
      almPenaltyAmount = principalInr.times(almPenaltyPct).div(100).toNumber();
    }
  }

  // FIXED: ALM penalty applied ONLY to FCNR (foreign currency deposit).
  // NRE is INR-denominated — the bank has no FX mismatch risk on NRE deposits.
  const fcnrEffectiveYieldPct = new Decimal(fcnrNominalPct).minus(almPenaltyPct).toNumber();
  // nreEffectiveYieldPct remains unchanged — NO ALM deduction on NRE.

  let calculationMethod = 'NOMINAL';
  let fcnrFinal = fcnrEffectiveYieldPct, nreFinal = nreEffectiveYieldPct;
  let fcnrRealYieldPct = null, nreRealYieldPct = null;

  if (india_inflation_rate !== undefined && foreign_inflation_rate !== undefined) {
    calculationMethod = 'REAL_PPP_ADJUSTED';
    fcnrRealYieldPct = calculateRealYield(fcnrEffectiveYieldPct, foreign_inflation_rate);
    nreRealYieldPct = calculateRealYield(nreEffectiveYieldPct, india_inflation_rate);
    fcnrFinal = fcnrRealYieldPct;
    nreFinal = nreRealYieldPct;
  }

  let recommendedProduct = 'EQUAL_YIELD';
  if (base_currency === 'INR') {
    recommendedProduct = 'NRE';
  } else {
    const diff = new Decimal(fcnrFinal).minus(nreFinal).toNumber();
    if (diff > config.business.decisionThresholdPct) recommendedProduct = 'FCNR';
    else if (diff < -config.business.decisionThresholdPct) recommendedProduct = 'NRE';
  }

  const fxRiskFlag = recommendedProduct === 'FCNR' && risk_profile === 'CONSERVATIVE';
  const fcnrProjectedBaseAmount = base_currency === 'INR'
    ? null
    : principal.times(calculateMaturityMultiplier(fcnrEffectiveYieldPct, tenure_months)).toNumber();
  const nreProjectedInrAmount = base_currency === 'INR'
    ? principal.times(calculateMaturityMultiplier(nreNominalPct, tenure_months)).toNumber()
    : principal.times(productSpotRate).times(calculateMaturityMultiplier(nreNominalPct, tenure_months)).toNumber();
  const nreProjectedBaseAmount = base_currency === 'INR'
    ? nreProjectedInrAmount
    : new Decimal(nreProjectedInrAmount).div(productForwardRate).toNumber();
  const fcnrProjectedInrAmount = base_currency === 'INR'
    ? null
    : new Decimal(fcnrProjectedBaseAmount).times(productForwardRate).toNumber();
  const projectionProduct = recommendedProduct === 'EQUAL_YIELD' ? 'NRE' : recommendedProduct;
  const recommendedProjectedBaseAmount = projectionProduct === 'FCNR' ? fcnrProjectedBaseAmount : nreProjectedBaseAmount;
  const alternativeProduct = base_currency === 'INR'
    ? 'NO_ACTION'
    : (projectionProduct === 'FCNR' ? 'NRE' : 'FCNR');
  const alternativeProjectedBaseAmount = alternativeProduct === 'NO_ACTION'
    ? principal.toNumber()
    : (alternativeProduct === 'FCNR' ? fcnrProjectedBaseAmount : nreProjectedBaseAmount);
  const projectionDifferenceBase = recommendedProjectedBaseAmount !== null && alternativeProjectedBaseAmount !== null
    ? new Decimal(recommendedProjectedBaseAmount).minus(alternativeProjectedBaseAmount).toNumber()
    : 0;

  const complianceWarnings = [];
  if (!portfolioAvailable) complianceWarnings.push('Portfolio data unavailable (ESB could not reach CBS). ALM penalty not applied.');
  if (debtToAssetRatio > 0.5) complianceWarnings.push(`Liquidity Advisory: High Debt-to-Asset ratio (${debtToAssetRatio.toFixed(2)}). Client may require immediate liquidity.`);
  if (recommendedProduct === 'FCNR') complianceWarnings.push('FCNR(B) cannot be prematurely withdrawn within the first 12 months per RBI Master Direction.');
  if (GCC_CURRENCIES.includes(base_currency)) complianceWarnings.push('GCC currency deposit routed through IFSC branch per RBI guidelines.');
  if (market_rates_override || fx_rate_overrides) complianceWarnings.push('RM-supplied rate override used. Recommendation is indicative — not based on live market data.');

  return {
    advisory: {
      recommended_product: recommendedProduct,
      compliance_warnings: complianceWarnings,
      fx_risk_flag: fxRiskFlag,
      projection: {
        horizon_months: tenure_months,
        reporting_currency: base_currency,
        followed_advice: {
          product: recommendedProduct,
          projected_amount: formatCurrency(recommendedProjectedBaseAmount || 0),
          projected_inr_amount: formatCurrency(recommendedProduct === 'FCNR' ? fcnrProjectedInrAmount : nreProjectedInrAmount),
        },
        did_not_follow_advice: {
          product: alternativeProduct,
          projected_amount: formatCurrency(alternativeProjectedBaseAmount || 0),
          projected_inr_amount: formatCurrency(alternativeProduct === 'NO_ACTION' ? principal : (alternativeProduct === 'FCNR' ? fcnrProjectedInrAmount : nreProjectedInrAmount)),
        },
        advantage_amount: formatCurrency(projectionDifferenceBase),
        advantage_pct: alternativeProjectedBaseAmount && alternativeProjectedBaseAmount > 0
          ? formatCurrency((projectionDifferenceBase / alternativeProjectedBaseAmount) * 100)
          : '0.00',
        assumptions: {
          spot_rate_used: productSpotRate !== null ? formatCurrency(productSpotRate, 4) : null,
          forward_rate_used: productForwardRate !== null ? formatCurrency(productForwardRate, 4) : null,
          fcnr_effective_yield_pct: base_currency === 'INR' ? '0.00' : formatCurrency(fcnrEffectiveYieldPct),
          nre_effective_yield_pct: formatCurrency(nreEffectiveYieldPct),
        },
      },
    },
    compliance: {
      premature_withdrawal_note: 'FCNR(B) deposits cannot be prematurely withdrawn within the first 12 months per RBI Master Direction.',
      tax_treatment: 'Interest on both NRE and FCNR(B) accounts is exempt from Indian Income Tax under Section 10(4) of the Income Tax Act, 1961, for qualifying NRIs.',
      tds_applicable: false,
    },
    decision_trace: {
      calculation_method: calculationMethod,
      product_spot_rate_used: productSpotRate !== null ? formatCurrency(productSpotRate, 4) : null,
      product_forward_rate_used: productForwardRate !== null ? formatCurrency(productForwardRate, 4) : null,
      rates_source: ratesSource,
      alm_policy_version: POLICY_VERSION,
      portfolio_fx_matrix_used: portfolioFxMatrix,
      total_assets_inr: formatCurrency(totalAssetsInr),
      total_liabilities_inr: formatCurrency(totalLiabilitiesInr),
      weighted_bank_assets_inr: formatCurrency(weightedBankAssetsInr),
      debt_to_asset_ratio: formatCurrency(debtToAssetRatio),
      alm_penalty_applied: almPenaltyApplied,
      alm_penalty_pct: formatCurrency(almPenaltyPct),
      alm_penalty_amount: formatCurrency(almPenaltyAmount),
      fcnr_effective_yield_pct: base_currency === 'INR' ? '0.00' : formatCurrency(fcnrEffectiveYieldPct),
      nre_effective_yield_pct: formatCurrency(nreEffectiveYieldPct),
      ...(calculationMethod === 'REAL_PPP_ADJUSTED' && {
        india_inflation_rate_used: parseFloat(india_inflation_rate).toFixed(2),
        foreign_inflation_rate_used: parseFloat(foreign_inflation_rate).toFixed(2),
        fcnr_real_yield_pct: fcnrRealYieldPct.toFixed(2),
        nre_real_yield_pct: nreRealYieldPct.toFixed(2),
      }),
    },
    metadata: {
      recommendation_id: randomUUID(),
      traceparent,
      customer_id,
      value_date,
      computed_at: new Date().toISOString(),
      rates_as_of: feed.rates_as_of || rateFeed.getRatesAsOf(),
      is_stale: feed.is_stale || false,
      retrieved_at: null,
      policy_version: POLICY_VERSION,
      execution_time_ms: Date.now() - startedAt,
      is_override_computation: Boolean(market_rates_override || fx_rate_overrides),
      portfolio_enrichment: { source: portfolioSource, positions_injected: { asset_count: assets.length, liability_count: liabilities.length } },
      user_role: userRole,
      employee_id: employeeId,
    },
  };
}

module.exports = { computeYield, validateOptimizeRequest, calculateRealYield, calculateMaturityMultiplier, CONSTANTS: { POLICY_VERSION, FCNR_ELIGIBLE_CURRENCIES, GCC_CURRENCIES, DEPOSIT_BASE_CURRENCIES, ASSET_TYPES, LIABILITY_TYPES, CHANNELS, RISK_PROFILES } };
