const optimizeRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'customer_id',
    'risk_profile',
    'principal_amount',
    'base_currency',
    'value_date',
    'tenure_months',
    'channel',
  ],
  properties: {
    customer_id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1, maxLength: 64 },
    risk_profile: { type: 'string', enum: ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'] },
    principal_amount: { type: 'string', pattern: '^\\d+\\.\\d{2}$' },
    base_currency: { type: 'string', enum: ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'JPY', 'CHF', 'HKD', 'AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD', 'INR'] },
    value_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    tenure_months: { type: 'integer', minimum: 12, maximum: 60 },
    channel: { type: 'string', enum: ['BRANCH', 'INTERNET_BANKING', 'MOBILE_APP', 'RM_PORTAL'] },
    branch_code: { type: 'string', pattern: '^[A-Za-z0-9-]+$' },
    india_inflation_rate: { type: 'string', pattern: '^-?\\d+\\.\\d{2,4}$' },
    foreign_inflation_rate: { type: 'string', pattern: '^-?\\d+\\.\\d{2,4}$' },
    is_manual_override: { type: 'boolean' },
    override_reason: { type: 'string', minLength: 1, maxLength: 1000 },
    approved_by: { type: 'string', pattern: '^[A-Za-z0-9-]+$' },
    approval_timestamp: { type: 'string' },
    override_ticket_id: { type: 'string', pattern: '^[A-Za-z0-9-]+$' },
    assets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['currency', 'asset_type', 'market_value'],
        properties: {
          currency: { type: 'string', enum: ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'JPY', 'CHF', 'HKD', 'AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD', 'INR'] },
          asset_type: { type: 'string', enum: ['FIXED_DEPOSIT', 'NRE_ACCOUNT', 'FCNR_ACCOUNT', 'SAVINGS_ACCOUNT', 'MUTUAL_FUND', 'EQUITY', 'OTHER'] },
          market_value: { type: 'string', pattern: '^\\d+\\.\\d{2}$' },
          source: { type: 'string' },
          valuation_date: { type: 'string' },
        },
      },
    },
    liabilities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['currency', 'liability_type', 'outstanding_principal'],
        properties: {
          currency: { type: 'string', enum: ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'JPY', 'CHF', 'HKD', 'AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD', 'INR'] },
          liability_type: { type: 'string', enum: ['HOME_LOAN', 'LOAN_AGAINST_PROPERTY', 'CAR_LOAN', 'PERSONAL_LOAN', 'CREDIT_CARD_OUTSTANDING', 'OTHER'] },
          outstanding_principal: { type: 'string', pattern: '^\\d+\\.\\d{2}$' },
          source: { type: 'string' },
          valuation_date: { type: 'string' },
        },
      },
    },
    fx_rate_overrides: {
      type: 'object',
      properties: {
        product_spot_rate: { type: 'string', pattern: '^\\d+\\.\\d{2,6}$' },
        forward_rates: {
          type: 'object',
          additionalProperties: { type: 'string', pattern: '^\\d+\\.\\d{2,6}$' },
        },
        portfolio_cross_rates: {
          type: 'object',
          additionalProperties: { type: 'string', pattern: '^\\d+\\.\\d{2,6}$' },
        },
      },
      additionalProperties: true,
    },
    market_rates_override: {
      type: 'object',
      properties: {
        fcnr_rate_pct: { type: 'string', pattern: '^-?\\d+\\.\\d{2,4}$' },
        nre_rate_pct: { type: 'string', pattern: '^-?\\d+\\.\\d{2,4}$' },
        override_reason: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      additionalProperties: true,
    },
  },
};

module.exports = { optimizeRequestSchema };