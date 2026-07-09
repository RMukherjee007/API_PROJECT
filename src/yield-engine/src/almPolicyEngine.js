const Decimal = require('decimal.js');

const HIGH_RISK_LOAN_TYPES = ['CREDIT_CARD_OUTSTANDING', 'PERSONAL_LOAN', 'UNSECURED_PERSONAL'];

class AlmPolicyEngine {
  /**
   * Dynamically calculates the ALM penalty percentage based on portfolio leverage, 
   * loan risk types, and deposit tenure.
   *
   * @param {Object} params
   * @param {Array} params.liabilities - List of customer liabilities/loans
   * @param {Decimal} params.totalLiabilitiesInr - Sum of all liabilities in INR
   * @param {Decimal} params.totalAssetsInr - Sum of all liquid assets in INR
   * @param {Decimal} params.principalInr - The new deposit principal in INR
   * @param {number} params.tenureMonths - The tenure of the new deposit
   * @param {Decimal} params.basePenaltyPct - The base maximum ALM penalty (e.g. 0.25%)
   * @returns {number} The calculated penalty percentage to be deducted from yield
   */
  static calculatePenalty({ liabilities, totalLiabilitiesInr, totalAssetsInr, principalInr, tenureMonths, basePenaltyPct }) {
    const totalLiab = new Decimal(totalLiabilitiesInr || 0);
    const totalAss = new Decimal(totalAssetsInr || 0);
    const princ = new Decimal(principalInr || 0);
    const basePct = new Decimal(basePenaltyPct || 0);

    if (!liabilities || liabilities.length === 0 || totalLiab.lte(0)) {
      return 0; // No debt, no penalty
    }

    const clientAssetsForRatio = totalAss.plus(princ);
    const debtToAssetRatio = clientAssetsForRatio.gt(0) ? totalLiab.div(clientAssetsForRatio) : new Decimal(0);

    // 1. Leverage Check
    if (debtToAssetRatio.lt(0.5)) {
      return 0;
    }

    // 2. Risk Profiling
    let highRiskDebtInr = new Decimal(0);
    for (const liab of liabilities) {
      if (HIGH_RISK_LOAN_TYPES.includes(liab.liability_type)) {
        highRiskDebtInr = highRiskDebtInr.plus(liab.outstanding_principal_inr || 0);
      }
    }

    // Base multiplier starts at 1.0
    let riskMultiplier = new Decimal(1.0);

    if (debtToAssetRatio.gt(1.0)) riskMultiplier = riskMultiplier.plus(0.5);
    if (debtToAssetRatio.gt(2.0)) riskMultiplier = riskMultiplier.plus(0.5);

    if (highRiskDebtInr.gt(0)) {
      riskMultiplier = riskMultiplier.plus(0.5);
      if (highRiskDebtInr.gt(10000000)) {
        riskMultiplier = riskMultiplier.plus(1.0);
      }
    }

    // 3. Tenure Dynamics
    if (tenureMonths >= 36) {
      riskMultiplier = riskMultiplier.times(0.8);
    }

    // Final calculation
    let finalPenaltyPct = basePct.times(riskMultiplier);

    if (finalPenaltyPct.gt(2.0)) finalPenaltyPct = new Decimal(2.0);

    return finalPenaltyPct.toDecimalPlaces(4).toNumber();
  }
}

module.exports = { AlmPolicyEngine };
