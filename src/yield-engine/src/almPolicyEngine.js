const HIGH_RISK_LOAN_TYPES = ['CREDIT_CARD_OUTSTANDING', 'PERSONAL_LOAN', 'UNSECURED_PERSONAL'];

class AlmPolicyEngine {
  /**
   * Dynamically calculates the ALM penalty percentage based on portfolio leverage, 
   * loan risk types, and deposit tenure.
   *
   * @param {Object} params
   * @param {Array} params.liabilities - List of customer liabilities/loans
   * @param {number} params.totalLiabilitiesInr - Sum of all liabilities in INR
   * @param {number} params.totalAssetsInr - Sum of all liquid assets in INR
   * @param {number} params.principalInr - The new deposit principal in INR
   * @param {number} params.tenureMonths - The tenure of the new deposit
   * @param {number} params.basePenaltyPct - The base maximum ALM penalty (e.g. 0.25%)
   * @returns {number} The calculated penalty percentage to be deducted from yield
   */
  static calculatePenalty({ liabilities, totalLiabilitiesInr, totalAssetsInr, principalInr, tenureMonths, basePenaltyPct }) {
    if (!liabilities || liabilities.length === 0 || totalLiabilitiesInr <= 0) {
      return 0; // No debt, no penalty
    }

    const clientAssetsForRatio = totalAssetsInr + principalInr;
    const debtToAssetRatio = clientAssetsForRatio > 0 ? totalLiabilitiesInr / clientAssetsForRatio : 0;

    // 1. Leverage Check
    // If assets heavily outweigh debt (ratio < 0.5), no ALM penalty is applied 
    // because the bank's liquidity risk is completely covered by the customer's assets.
    if (debtToAssetRatio < 0.5) {
      return 0;
    }

    // 2. Risk Profiling
    let highRiskDebtInr = 0;
    for (const liab of liabilities) {
      if (HIGH_RISK_LOAN_TYPES.includes(liab.liability_type)) {
        // CRITICAL: This calculation assumes that totalLiabilitiesInr was calculated
        // by converting all liabilities to INR. We must ensure the `liabilities` array
        // passed in has INR-equivalent values if we are to sum them.
        // Assuming `liab.outstanding_principal_inr` is now available after pre-conversion.
        highRiskDebtInr += (liab.outstanding_principal_inr || 0);
      }
    }

    // Base multiplier starts at 1.0 (meaning they get the full base penalty)
    let riskMultiplier = 1.0;

    // Scale up if they are highly leveraged
    if (debtToAssetRatio > 1.0) riskMultiplier += 0.5;
    if (debtToAssetRatio > 2.0) riskMultiplier += 0.5;

    // Scale up if they have high risk debt
    if (highRiskDebtInr > 0) {
      riskMultiplier += 0.5;
      // Huge high-risk loan check (> 10M)
      if (highRiskDebtInr > 10000000) {
        riskMultiplier += 1.0; // Severe liquidity risk
      }
    }

    // 3. Tenure Dynamics
    // If the customer locks money in for a long time (> 36 months), it stabilizes the bank's ALM, reducing the penalty.
    // The < 12 month check is removed as it's unreachable; validation layer enforces a 12-month minimum.
    if (tenureMonths >= 36) {
      riskMultiplier *= 0.8;
    }

    // Final calculation
    let finalPenaltyPct = basePenaltyPct * riskMultiplier;

    // Cap the penalty at a reasonable maximum (e.g. 2.00%) so we don't return negative yields.
    if (finalPenaltyPct > 2.0) finalPenaltyPct = 2.0;

    return Number(finalPenaltyPct.toFixed(4));
  }
}

module.exports = { AlmPolicyEngine };
