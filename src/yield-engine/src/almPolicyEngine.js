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
        // We use outstanding_principal but since we need it in INR, we approximate 
        // its share of the totalLiabilitiesInr (or assume it's already converted if we pass it,
        // but here we just check if any high risk debt exists to scale).
        // For simplicity, we just flag the presence and relative size of high risk debt.
        highRiskDebtInr += (parseFloat(liab.outstanding_principal) || 0); // Note: This ignores FX on the liab itself if it's foreign, but typically retail high-risk debt is domestic.
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
    // If the customer has high debt but is locking in money for a short time (< 12 months), 
    // the bank faces a short-term liquidity mismatch, increasing the penalty.
    // If they lock it in for a long time (> 36 months), it stabilizes the bank's ALM, reducing the penalty.
    if (tenureMonths < 12) {
      riskMultiplier *= 1.2;
    } else if (tenureMonths >= 36) {
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
