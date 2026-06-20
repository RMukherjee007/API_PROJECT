const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8082;

// In-Memory DB (Replaces MySQL for Docker-free local testing)
const mockAuditDB = new Map(); // recommendation_id -> { storedAt, body }
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Live Market Feed & Policy Store
const POLICY_VERSION = 'POL-2026-Q2';
let ratesAsOf = '2026-06-18T10:00:00Z'; // mutable mock timestamp

const PREMIUM_MAP = {
    USD: 0.01916,
    GBP: 0.01235,
    EUR: 0.01331,
    CAD: 0.01143,
    AUD: 0.01254,
    SGD: 0.01121,
    JPY: 0.01250,
    CHF: 0.01259,
    HKD: 0.01215,
    AED: 0.01627,
    SAR: 0.01527,
    QAR: 0.01569,
    OMR: 0.01517,
    BHD: 0.01531,
    KWD: 0.01572
};

// const liveMarketFeed = {
//     spot: {
//         'USD/INR': '83.500000',
//         'GBP/INR': '105.200000',
//         'EUR/INR': '90.100000',
//         'CAD/INR': '61.200000',
//         'AUD/INR': '55.800000',
//         'SGD/INR': '62.400000',
//         'JPY/INR': '0.560000',
//         'CHF/INR': '95.300000',
//         'HKD/INR': '10.700000',
//         'AED/INR': '22.730000',
//         'SAR/INR': '22.260000',
//         'QAR/INR': '22.940000',
//         'OMR/INR': '217.500000',
//         'BHD/INR': '222.000000',
//         'KWD/INR': '273.500000',
//     },
//     // Forward curves keyed by currency pair, then tenure in months.
//     forward: {
//         'USD/INR': { '12': '85.100000', '24': '85.800000', '36': '86.500000', '48': '87.100000', '60': '87.800000' },
//         'GBP/INR': { '12': '106.500000', '24': '107.300000', '36': '108.000000', '48': '108.700000', '60': '109.400000' },
//         'EUR/INR': { '12': '91.300000', '24': '92.100000', '36': '93.000000', '48': '93.800000', '60': '94.600000' },
//         'CAD/INR': { '12': '61.900000', '24': '62.600000', '36': '63.300000', '48': '64.000000', '60': '64.700000' },
//         'AUD/INR': { '12': '56.500000', '24': '57.200000', '36': '57.900000', '48': '58.600000', '60': '59.300000' },
//         'SGD/INR': { '12': '63.100000', '24': '63.800000', '36': '64.500000', '48': '65.200000', '60': '65.900000' },
//         'JPY/INR': { '12': '0.567000', '24': '0.574000', '36': '0.581000', '48': '0.588000', '60': '0.595000' },
//         'CHF/INR': { '12': '96.500000', '24': '97.700000', '36': '98.900000', '48': '100.100000', '60': '101.300000' },
//         'HKD/INR': { '12': '10.830000', '24': '10.960000', '36': '11.090000', '48': '11.220000', '60': '11.350000' },
//         'AED/INR': { '12': '23.100000', '24': '23.500000', '36': '23.900000', '48': '24.300000', '60': '24.700000' },
//         'SAR/INR': { '12': '22.600000', '24': '22.950000', '36': '23.300000', '48': '23.650000', '60': '24.000000' },
//         'QAR/INR': { '12': '23.300000', '24': '23.670000', '36': '24.040000', '48': '24.410000', '60': '24.780000' },
//         'OMR/INR': { '12': '220.800000', '24': '224.100000', '36': '227.500000', '48': '230.800000', '60': '234.200000' },
//         'BHD/INR': { '12': '225.400000', '24': '228.800000', '36': '232.300000', '48': '235.700000', '60': '239.200000' },
//         'KWD/INR': { '12': '277.800000', '24': '282.100000', '36': '286.500000', '48': '290.800000', '60': '295.200000' },
//     },
// };

const mockPolicyStore = {
    fcnr: {
        USD: '5.20', GBP: '4.80', EUR: '3.50', CAD: '4.10', AUD: '4.60',
        SGD: '3.20', JPY: '0.80', CHF: '1.20', HKD: '3.90',
        AED: '4.20', SAR: '4.00', QAR: '4.10', fcnrBaseRates: { 'USD': 5.20, 'GBP': 4.80, 'EUR': 3.90, 'CAD': 4.50, 'AUD': 4.60, 'SGD': 3.80, 'JPY': 0.50, 'CHF': 1.20 },
    },
    nre: '7.25', // NRE is always INR-denominated
    almPenaltyPct: 0.35, // flat policy-defined percentage penalty applied when liabilities > assets
};

const FCNR_ELIGIBLE_CURRENCIES = Object.keys(mockPolicyStore.fcnr);
const GCC_CURRENCIES = ['AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD'];
const DEPOSIT_BASE_CURRENCIES = [...FCNR_ELIGIBLE_CURRENCIES, 'INR'];
const POSITION_CURRENCIES = DEPOSIT_BASE_CURRENCIES;
const ASSET_TYPES = ['FIXED_DEPOSIT', 'NRE_ACCOUNT', 'FCNR_ACCOUNT', 'SAVINGS_ACCOUNT', 'MUTUAL_FUND', 'EQUITY', 'OTHER'];
const LIABILITY_TYPES = ['HOME_LOAN', 'LOAN_AGAINST_PROPERTY', 'CAR_LOAN', 'PERSONAL_LOAN', 'CREDIT_CARD_OUTSTANDING', 'OTHER'];
const CHANNELS = ['BRANCH', 'INTERNET_BANKING', 'MOBILE_APP', 'RM_PORTAL'];
const RISK_PROFILES = ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'];

const DECIMAL_2DP = /^\d+\.\d{2}$/;
const PCT_PATTERN = /^-?\d+\.\d{2,4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// RFC 7807 problem helper
function sendError(res, status, errorCode, detail, traceparent, invalidFields = null) {
    const type = `https://api.bank.com/errors/${errorCode.toLowerCase().replace(/_/g, '-')}`;
    const title = errorCode.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    const body = {
        type,
        title,
        status,
        detail,
        instance: traceparent || `00-${uuidv4().replace(/-/g, '')}-0000000000000000-01`,
        error_code: errorCode
    };
    if (invalidFields) {
        body.invalid_fields = invalidFields;
    }
    return res.status(status).type('application/problem+json').json(body);
}

// Request validation
function validateRequest(body, traceparent) {
    const invalidFields = {};

    const required = ['customer_id', 'risk_profile', 'principal_amount', 'base_currency', 'value_date', 'tenure_months', 'channel'];
    for (const field of required) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
            invalidFields[field] = 'is required';
        }
    }
    if (Object.keys(invalidFields).length > 0) {
        return { status: 400, errorCode: 'MISSING_REQUIRED_FIELD', detail: 'One or more required fields are missing.', invalidFields };
    }

    if (!RISK_PROFILES.includes(body.risk_profile)) {
        invalidFields.risk_profile = `must be one of: ${RISK_PROFILES.join(', ')}`;
    }
    if (!CHANNELS.includes(body.channel)) {
        invalidFields.channel = `must be one of: ${CHANNELS.join(', ')}`;
    }
    if (typeof body.customer_id !== 'string' || !/^[A-Za-z0-9-_]+$/.test(body.customer_id)) {
        invalidFields.customer_id = 'must match ^[A-Za-z0-9-_]+$';
    }
    if (typeof body.principal_amount !== 'string' || !DECIMAL_2DP.test(body.principal_amount)) {
        invalidFields.principal_amount = 'must be a decimal string with exactly 2 decimal places, e.g. "1000000.00"';
    }
    if (typeof body.value_date !== 'string' || !DATE_PATTERN.test(body.value_date)) {
        invalidFields.value_date = 'must be in YYYY-MM-DD format';
    }
    if (body.india_inflation_rate !== undefined && (typeof body.india_inflation_rate !== 'string' || !PCT_PATTERN.test(body.india_inflation_rate))) {
        invalidFields.india_inflation_rate = 'must match ^-?\\d+\\.\\d{2,4}$';
    }
    if (body.foreign_inflation_rate !== undefined && (typeof body.foreign_inflation_rate !== 'string' || !PCT_PATTERN.test(body.foreign_inflation_rate))) {
        invalidFields.foreign_inflation_rate = 'must match ^-?\\d+\\.\\d{2,4}$';
    }
    if (Object.keys(invalidFields).length > 0) {
        return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'One or more fields failed format validation.', invalidFields };
    }

    // Conditional: branch_code required for BRANCH / RM_PORTAL channels
    if (['BRANCH', 'RM_PORTAL'].includes(body.channel) && !body.branch_code) {
        return { status: 400, errorCode: 'MISSING_REQUIRED_FIELD', detail: 'branch_code is required when channel is BRANCH or RM_PORTAL.', invalidFields: { branch_code: 'is required for this channel' } };
    }
    if (body.branch_code && (typeof body.branch_code !== 'string' || !/^[A-Za-z0-9-]+$/.test(body.branch_code))) {
        return { status: 400, errorCode: 'INVALID_FORMAT', detail: 'branch_code must match ^[A-Za-z0-9-]+$', invalidFields: { branch_code: 'must match ^[A-Za-z0-9-]+$' } };
    }

    // Conditional: manual override fields
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

    // Semantic (422) checks
    if (!DEPOSIT_BASE_CURRENCIES.includes(body.base_currency)) {
        return { status: 422, errorCode: 'INVALID_CURRENCY', detail: `base_currency "${body.base_currency}" is not supported.`, invalidFields: { base_currency: `must be one of: ${DEPOSIT_BASE_CURRENCIES.join(', ')}` } };
    }

    const tenure = Number(body.tenure_months);
    if (!Number.isInteger(tenure) || tenure < 12 || tenure > 60) {
        return { status: 422, errorCode: 'TENURE_OUT_OF_RANGE', detail: 'tenure_months must be an integer between 12 and 60.', invalidFields: { tenure_months: 'must be between 12 and 60' } };
    }

    const today = new Date().toISOString().slice(0, 10);
    if (body.value_date < today) {
        return { status: 422, errorCode: 'VALUE_DATE_IN_PAST', detail: 'value_date must not be before the current date.', invalidFields: { value_date: 'must not be in the past' } };
    }

    // GCC currency must route through IFSC
    if (GCC_CURRENCIES.includes(body.base_currency)) {
        const branch = body.branch_code || '';
        if (!branch.toUpperCase().startsWith('GIFT')) {
            return { status: 422, errorCode: 'GCC_REQUIRES_IFSC_BRANCH', detail: 'GCC currency deposits require an IFSC (GIFT City) branch code.', invalidFields: { branch_code: 'must belong to an IFSC unit when base_currency is a GCC currency' } };
        }
    }

    // Positions validation
    for (const [idx, a] of (body.assets || []).entries()) {
        if (!POSITION_CURRENCIES.includes(a.currency)) {
            return { status: 422, errorCode: 'INVALID_CURRENCY', detail: `assets[${idx}].currency "${a.currency}" is not supported.`, invalidFields: { [`assets[${idx}].currency`]: 'unsupported currency' } };
        }
        if (!ASSET_TYPES.includes(a.asset_type)) {
            return { status: 422, errorCode: 'INVALID_FORMAT', detail: `assets[${idx}].asset_type "${a.asset_type}" is invalid.`, invalidFields: { [`assets[${idx}].asset_type`]: `must be one of: ${ASSET_TYPES.join(', ')}` } };
        }
        if (!a.market_value || typeof a.market_value !== 'string' || !DECIMAL_2DP.test(a.market_value)) {
            return { status: 422, errorCode: 'INVALID_FORMAT', detail: `assets[${idx}].market_value must be a string with 2 decimal places.`, invalidFields: { [`assets[${idx}].market_value`]: 'must match ^\\d+\\.\\d{2}$' } };
        }
    }
    for (const [idx, l] of (body.liabilities || []).entries()) {
        if (!POSITION_CURRENCIES.includes(l.currency)) {
            return { status: 422, errorCode: 'INVALID_CURRENCY', detail: `liabilities[${idx}].currency "${l.currency}" is not supported.`, invalidFields: { [`liabilities[${idx}].currency`]: 'unsupported currency' } };
        }
        if (!LIABILITY_TYPES.includes(l.liability_type)) {
            return { status: 422, errorCode: 'INVALID_FORMAT', detail: `liabilities[${idx}].liability_type "${l.liability_type}" is invalid.`, invalidFields: { [`liabilities[${idx}].liability_type`]: `must be one of: ${LIABILITY_TYPES.join(', ')}` } };
        }
        if (!l.outstanding_principal || typeof l.outstanding_principal !== 'string' || !DECIMAL_2DP.test(l.outstanding_principal)) {
            return { status: 422, errorCode: 'INVALID_FORMAT', detail: `liabilities[${idx}].outstanding_principal must be a string with 2 decimal places.`, invalidFields: { [`liabilities[${idx}].outstanding_principal`]: 'must match ^\\d+\\.\\d{2}$' } };
        }
    }

    return null;
}

// Math logic / Fisher helper
function calculateRealYield(nominalYieldPct, inflationPct) {
    const nominal = nominalYieldPct / 100;
    const inflation = inflationPct / 100;
    const real = ((1 + nominal) / (1 + inflation)) - 1;
    return real * 100;
}

// POST /optimize
app.post('/optimize', async (req, res) => {
    const startedAt = Date.now();
    const traceparent = req.headers['traceparent'] || `00-${uuidv4().replace(/-/g, '')}-0000000000000000-01`;
    const employeeId = req.headers['x-employee-id'] || 'UNKNOWN';
    const userRole = req.headers['x-user-role'] || 'RM';
    const portfolioSource = req.headers['x-portfolio-source'] || 'NOT_AVAILABLE';

    try {
        const body = req.body || {};

        // Normalize assets and liabilities to 2 decimal places to match schema regex
        if (body.assets) {
            body.assets = body.assets.map(a => ({
                ...a,
                market_value: a.market_value !== undefined && !isNaN(parseFloat(a.market_value)) ? parseFloat(a.market_value).toFixed(2) : a.market_value
            }));
        }
        if (body.liabilities) {
            body.liabilities = body.liabilities.map(l => ({
                ...l,
                outstanding_principal: l.outstanding_principal !== undefined && !isNaN(parseFloat(l.outstanding_principal)) ? parseFloat(l.outstanding_principal).toFixed(2) : l.outstanding_principal
            }));
        }

        // 1. Perform full request validations
        const validationError = validateRequest(body, traceparent);
        if (validationError) {
            return sendError(res, validationError.status, validationError.errorCode, validationError.detail, traceparent, validationError.invalidFields);
        }

        const {
            customer_id, risk_profile, principal_amount, base_currency, value_date, tenure_months,
            india_inflation_rate, foreign_inflation_rate, fx_rate_overrides, market_rates_override,
            assets = [], liabilities = [],
        } = body;

        // 2. Validate principal threshold (Min USD 1000 equivalent)
        const principal = parseFloat(principal_amount);
        let usdEquivalent = principal;
        if (base_currency !== 'USD') {
            let principalInr = principal;
            if (base_currency !== 'INR') {
                const pair = `${base_currency}/INR`;
                const spotRate = parseFloat(liveMarketFeed.spot[pair]);
                principalInr = principal * spotRate;
            }
            const usdInrRate = parseFloat(liveMarketFeed.spot['USD/INR']);
            usdEquivalent = principalInr / usdInrRate;
        }
        if (usdEquivalent < 1000) {
            return sendError(res, 422, 'PRINCIPAL_BELOW_MINIMUM', 'Principal amount is below the bank\'s FCNR regulatory minimum of USD 1,000 equivalent.', traceparent, { principal_amount: 'must be at least USD 1,000 equivalent' });
        }

        // 3. Validate override deviation caps
        if (fx_rate_overrides) {
            // Removed spot rate override limits
            if (fx_rate_overrides.forward_rates && base_currency !== 'INR') {
                const pair = `${base_currency}/INR`;
                for (const tenureKey of Object.keys(fx_rate_overrides.forward_rates)) {
                    const liveFwd = parseFloat(liveMarketFeed.forward[pair]?.[tenureKey] || liveMarketFeed.spot[pair]);
                    const overrideFwd = parseFloat(fx_rate_overrides.forward_rates[tenureKey]);
                    const deviation = Math.abs(overrideFwd - liveFwd) / liveFwd * 100;

                }
            }
            if (fx_rate_overrides.portfolio_cross_rates) {
                for (const pair of Object.keys(fx_rate_overrides.portfolio_cross_rates)) {
                    const liveSpot = parseFloat(liveMarketFeed.spot[pair]);
                    if (!liveSpot) {
                        return sendError(res, 422, 'UNSUPPORTED_CURRENCY_PAIR', `Unsupported cross-rate currency pair: ${pair}`, traceparent, { [`fx_rate_overrides.portfolio_cross_rates.${pair}`]: 'unsupported currency pair' });
                    }
                }
            }
        }

        if (market_rates_override) {
            if (userRole === 'RM') {
                return sendError(res, 403, 'INSUFFICIENT_ROLE', 'RMs are not authorized to submit interest rate overrides.', traceparent);
            }
            if (!market_rates_override.override_reason || market_rates_override.override_reason.trim() === '') {
                return sendError(res, 400, 'MISSING_REQUIRED_FIELD', 'market_rates_override.override_reason is missing.', traceparent, { 'market_rates_override.override_reason': 'missing' });
            }
            // Deviation cap check for market_rates_override has been removed
            if (market_rates_override.fcnr_rate_pct !== undefined) {
                // Rate applies directly later
            }
            if (market_rates_override.nre_rate_pct !== undefined) {
                // Rate applies directly later
            }
        }

        // 4. Calculations Setup
        let fcnrNominalPct = parseFloat(mockPolicyStore.fcnr[base_currency] || '0.00');
        let nreNominalPct = parseFloat(mockPolicyStore.nre);
        let ratesSource = 'LIVE_MARKET_API';

        if (base_currency === 'INR') {
            ratesSource = 'POLICY_STORE';
        }

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
        let nreEffectiveYieldPct = nreNominalPct; // default NRE yield for INR

        if (base_currency !== 'INR') {
            const pair = `${base_currency}/INR`;

            // 5. Determine Spot Rate (No Frankfurter Live API calls!)
            if (fx_rate_overrides && fx_rate_overrides.product_spot_rate) {
                productSpotRate = parseFloat(fx_rate_overrides.product_spot_rate);
            } else {
                productSpotRate = parseFloat(liveMarketFeed.spot[pair]);
            }

            // 6. Determine Forward Rate from Curve/Overrides (No circular CIRP calculations!)
            const tenureKey = String(tenure_months);
            if (fx_rate_overrides && fx_rate_overrides.forward_rates && fx_rate_overrides.forward_rates[tenureKey]) {
                productForwardRate = parseFloat(fx_rate_overrides.forward_rates[tenureKey]);
            } else {
                productForwardRate = parseFloat(liveMarketFeed.forward[pair]?.[tenureKey] || productSpotRate);
            }

            // 7. Calculate FX-Adjusted nominal NRE yield
            const rNre = nreNominalPct / 100;
            nreEffectiveYieldPct = (Math.pow((Math.pow(1 + rNre, T) * (productSpotRate / productForwardRate)), 1 / T) - 1) * 100;
        }

        // 8. ALM Penalty Conversion (Flat check liabilities > assets)
        let totalAssetsInr = 0;
        let totalLiabilitiesInr = 0;
        const portfolioFxMatrix = {};

        assets.forEach(asset => {
            const val = parseFloat(asset.market_value);
            if (asset.currency === 'INR') {
                totalAssetsInr += val;
            } else {
                const pair = `${asset.currency}/INR`;
                let rate = parseFloat(liveMarketFeed.spot[pair]);
                if (fx_rate_overrides && fx_rate_overrides.portfolio_cross_rates && fx_rate_overrides.portfolio_cross_rates[pair]) {
                    rate = parseFloat(fx_rate_overrides.portfolio_cross_rates[pair]);
                }
                if (isNaN(rate)) throw new Error(`Missing market rate for currency pair: ${pair}`);
                portfolioFxMatrix[pair] = rate.toFixed(6);
                totalAssetsInr += (val * rate);
            }
        });

        liabilities.forEach(liab => {
            const val = parseFloat(liab.outstanding_principal);
            if (liab.currency === 'INR') {
                totalLiabilitiesInr += val;
            } else {
                const pair = `${liab.currency}/INR`;
                let rate = parseFloat(liveMarketFeed.spot[pair]);
                if (fx_rate_overrides && fx_rate_overrides.portfolio_cross_rates && fx_rate_overrides.portfolio_cross_rates[pair]) {
                    rate = parseFloat(fx_rate_overrides.portfolio_cross_rates[pair]);
                }
                if (isNaN(rate)) throw new Error(`Missing market rate for currency pair: ${pair}`);
                portfolioFxMatrix[pair] = rate.toFixed(6);
                totalLiabilitiesInr += (val * rate);
            }
        });

        const portfolioAvailable = portfolioSource !== 'NOT_AVAILABLE';
        // Convert principal amount to INR for the ALM check
        let principalInr = principal;
        if (base_currency !== 'INR') {
            const pair = `${base_currency}/INR`;
            const rate = parseFloat(portfolioFxMatrix[pair] || liveMarketFeed.spot[pair]);
            if (isNaN(rate)) throw new Error(`Missing market rate for currency pair: ${pair}`);
            principalInr = principal * rate;
        }

        // Proper Continuous ALM Penalty
        let almPenaltyApplied = false;
        let almPenaltyPct = 0.00;
        let almPenaltyAmount = 0.00;

        if (portfolioAvailable) {
            // ALM Perspective: Client Assets = Bank Liabilities. Client Liabilities = Bank Assets.
            const bankLiabilitiesInr = totalAssetsInr + principalInr;
            const bankAssetsInr = totalLiabilitiesInr;
            const netMismatchInr = bankLiabilitiesInr - bankAssetsInr;
            
            if (netMismatchInr > 0) {
                almPenaltyApplied = true;
                let mismatchRatio = 1.0; // Default to max penalty if no liabilities
                if (bankLiabilitiesInr > 0) {
                    mismatchRatio = netMismatchInr / bankLiabilitiesInr;
                    if (mismatchRatio > 1.0) mismatchRatio = 1.0; // Cap ratio at 100%
                }
                almPenaltyPct = mismatchRatio * mockPolicyStore.almPenaltyPct;
                almPenaltyAmount = principalInr * (almPenaltyPct / 100);
            }
        }

        const fcnrEffectiveYieldPct = fcnrNominalPct - almPenaltyPct;
        nreEffectiveYieldPct = nreEffectiveYieldPct - almPenaltyPct;

        // 9. Inflation Adjustment (Fisher Equation only)
        let calculationMethod = 'NOMINAL';
        let fcnrFinal = fcnrEffectiveYieldPct;
        let nreFinal = nreEffectiveYieldPct;
        let fcnrRealYieldPct = null;
        let nreRealYieldPct = null;

        if (india_inflation_rate !== undefined && foreign_inflation_rate !== undefined) {
            calculationMethod = 'REAL_PPP_ADJUSTED';
            const indiaPi = parseFloat(india_inflation_rate);
            const foreignPi = parseFloat(foreign_inflation_rate);
            fcnrRealYieldPct = calculateRealYield(fcnrEffectiveYieldPct, foreignPi);
            nreRealYieldPct = calculateRealYield(nreEffectiveYieldPct, indiaPi);
            fcnrFinal = fcnrRealYieldPct;
            nreFinal = nreRealYieldPct;
        }

        // 10. Decision Matrix with 0.15% buffer
        let recommendedProduct = 'EQUAL_YIELD';
        if (base_currency === 'INR') {
            recommendedProduct = 'NRE';
        } else {
            const diff = fcnrFinal - nreFinal;
            if (diff > 0.15) {
                recommendedProduct = 'FCNR';
            } else if (diff < -0.15) {
                recommendedProduct = 'NRE';
            }
        }

        const fxRiskFlag = recommendedProduct === 'FCNR' && risk_profile === 'CONSERVATIVE';

        // Compliance notices
        const complianceWarnings = [];
        if (!portfolioAvailable) {
            complianceWarnings.push('Portfolio data unavailable (ESB could not reach CBS). ALM penalty not applied.');
        }
        if (recommendedProduct === 'FCNR') {
            complianceWarnings.push('FCNR(B) cannot be prematurely withdrawn within the first 12 months per RBI Master Direction.');
        }
        if (GCC_CURRENCIES.includes(base_currency)) {
            complianceWarnings.push('GCC currency deposit routed through IFSC branch per RBI guidelines.');
        }
        if (market_rates_override || fx_rate_overrides) {
            complianceWarnings.push('RM-supplied rate override used. Recommendation is indicative — not based on live market data.');
        }

        // Format all floats to decimal strings to comply strictly with schema constraints
        const responseBody = {
            advisory: {
                recommended_product: recommendedProduct,
                compliance_warnings: complianceWarnings,
                fx_risk_flag: fxRiskFlag
            },
            compliance: {
                premature_withdrawal_note: 'FCNR(B) deposits cannot be prematurely withdrawn within the first 12 months per RBI Master Direction.',
                tax_treatment: 'Interest on both NRE and FCNR(B) accounts is exempt from Indian Income Tax under Section 10(4) of the Income Tax Act, 1961, for qualifying NRIs.',
                tds_applicable: false
            },
            decision_trace: {
                calculation_method: calculationMethod,
                product_spot_rate_used: productSpotRate !== null ? productSpotRate.toFixed(4) : null,
                product_forward_rate_used: productForwardRate !== null ? productForwardRate.toFixed(4) : null,
                rates_source: ratesSource,
                alm_policy_version: POLICY_VERSION,
                portfolio_fx_matrix_used: portfolioFxMatrix,
                total_assets_inr: totalAssetsInr.toFixed(2),
                total_liabilities_inr: totalLiabilitiesInr.toFixed(2),
                alm_penalty_applied: almPenaltyApplied,
                alm_penalty_pct: almPenaltyPct.toFixed(2),
                alm_penalty_amount: almPenaltyAmount.toFixed(2),
                fcnr_effective_yield_pct: base_currency === 'INR' ? '0.00' : fcnrEffectiveYieldPct.toFixed(2),
                nre_effective_yield_pct: nreEffectiveYieldPct.toFixed(2),
                ...(calculationMethod === 'REAL_PPP_ADJUSTED' && {
                    india_inflation_rate_used: parseFloat(india_inflation_rate).toFixed(2),
                    foreign_inflation_rate_used: parseFloat(foreign_inflation_rate).toFixed(2),
                    fcnr_real_yield_pct: fcnrRealYieldPct.toFixed(2),
                    nre_real_yield_pct: nreRealYieldPct.toFixed(2)
                })
            },
            metadata: {
                recommendation_id: uuidv4(),
                traceparent: traceparent,
                customer_id: customer_id,
                value_date: value_date,
                computed_at: new Date().toISOString(),
                rates_as_of: ratesAsOf,
                retrieved_at: null,
                policy_version: POLICY_VERSION,
                execution_time_ms: Date.now() - startedAt,
                is_override_computation: Boolean(market_rates_override || fx_rate_overrides),
                portfolio_enrichment: {
                    source: portfolioSource,
                    positions_injected: {
                        asset_count: assets.length,
                        liability_count: liabilities.length
                    }
                }
            }
        };

        // Cache successful response in audit store
        mockAuditDB.set(responseBody.metadata.recommendation_id, {
            storedAt: Date.now(),
            body: responseBody
        });

        return res.status(200).json(responseBody);

    } catch (err) {
        console.error('[Microservice] Exception:', err);
        return sendError(res, 500, 'DEPENDENCY_TIMEOUT', 'An unexpected error occurred while computing the recommendation.', traceparent);
    }
});

// GET /recommendations/:recommendation_id
app.get('/recommendations/:recommendation_id', (req, res) => {
    const traceparent = req.headers['traceparent'] || `00-${uuidv4().replace(/-/g, '')}-0000000000000000-01`;
    const { recommendation_id } = req.params;

    const record = mockAuditDB.get(recommendation_id);
    if (!record) {
        return sendError(res, 404, 'RECOMMENDATION_NOT_FOUND', `No recommendation found for ID "${recommendation_id}".`, traceparent);
    }

    if (Date.now() - record.storedAt > AUDIT_RETENTION_MS) {
        return sendError(res, 404, 'RECOMMENDATION_EXPIRED', 'The requested recommendation has expired beyond the 90-day retention window.', traceparent);
    }

    const responseBody = JSON.parse(JSON.stringify(record.body));
    responseBody.metadata.retrieved_at = new Date().toISOString();

    return res.status(200).json(responseBody);
});

// GET /rates
app.get('/rates', (req, res) => {
    const nreRates = [12, 24, 36, 48, 60].map((m) => ({
        tenure_months: m,
        annual_rate_pct: mockPolicyStore.nre,
        effective_from: '2026-01-01',
    }));

    const fcnrRates = FCNR_ELIGIBLE_CURRENCIES.map((currency) => ({
        currency,
        tenures: [12, 24, 36, 48, 60].map((m) => ({
            tenure_months: m,
            annual_rate_pct: mockPolicyStore.fcnr[currency],
            effective_from: '2026-01-01',
        })),
    }));

    return res.status(200).json({
        policy_version: POLICY_VERSION,
        rates_as_of: ratesAsOf,
        nre_rates: nreRates,
        fcnr_rates: fcnrRates,
        fx_spot_rates: liveMarketFeed.spot,
        fx_forward_rates: liveMarketFeed.forward,
    });
});

// GET /health/ready
app.get('/health/ready', (req, res) => {
    return res.status(200).json({
        status: 'ok',
        dependencies: {
            tms_feed: { status: 'ok', is_critical: true, circuit_state: 'CLOSED', latency_ms: 4 },
            policy_config_store: { status: 'ok', is_critical: true, circuit_state: 'CLOSED', latency_ms: 2 },
            idempotency_cache: { status: 'ok', is_critical: true, circuit_state: 'CLOSED', latency_ms: 1 },
            audit_store: { status: 'ok', is_critical: false, circuit_state: 'CLOSED', latency_ms: 3 }
        }
    });
});

async function updateLiveRates() {
    try {
        console.log('[Microservice] Fetching live rates from open.er-api.com...');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

        const response = await fetch('https://open.er-api.com/v6/latest/INR', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (data && data.result === 'success' && data.rates) {
            const rates = data.rates;

            // Recompute spot rates for ALL currencies provided by the API
            for (const currency of Object.keys(rates)) {
                if (currency === 'INR') continue;
                const spotInr = 1 / rates[currency];
                liveMarketFeed.spot[`${currency}/INR`] = spotInr.toFixed(6);
            }

            // Recompute forward curves
            for (const currency of FCNR_ELIGIBLE_CURRENCIES) {
                const pair = `${currency}/INR`;
                const spotVal = parseFloat(liveMarketFeed.spot[pair]);
                if (isNaN(spotVal)) continue;
                const premium = PREMIUM_MAP[currency] || 0.015;

                liveMarketFeed.forward[pair] = {
                    '12': (spotVal * (1 + premium * 1.0)).toFixed(6),
                    '24': (spotVal * (1 + premium * 2.0)).toFixed(6),
                    '36': (spotVal * (1 + premium * 3.0)).toFixed(6),
                    '48': (spotVal * (1 + premium * 4.0)).toFixed(6),
                    '60': (spotVal * (1 + premium * 5.0)).toFixed(6),
                };
            }
            ratesAsOf = data.time_last_update_utc || new Date().toISOString();
            console.log(`[Microservice] Live rates updated successfully for ${Object.keys(rates).length} currencies!`);
        }
    } catch (err) {
        console.error('[Microservice] Failed to fetch live rates (using fallback):', err.message);
    }
}

app.listen(PORT, () => {
    console.log(`[Microservice] Math Engine listening on port ${PORT}`);
    // Run live exchange rate fetch on startup and every 1 minute
    updateLiveRates();
    setInterval(updateLiveRates, 60 * 1000);
});
