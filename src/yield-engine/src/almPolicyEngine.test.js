const { AlmPolicyEngine } = require('./almPolicyEngine');

describe('AlmPolicyEngine', () => {
  it('should return 0 penalty when there are no liabilities', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [],
      totalLiabilitiesInr: 0,
      totalAssetsInr: 50000,
      principalInr: 10000,
      tenureMonths: 12,
      basePenaltyPct: 0.25
    });
    expect(penalty).toBe(0);
  });

  it('should return 0 penalty when debt to asset ratio is below 0.5', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [{ liability_type: 'HOME_LOAN', outstanding_principal: '40000' }],
      totalLiabilitiesInr: 40000,
      totalAssetsInr: 90000, // Ratio: 40000 / (90000 + 10000) = 40000 / 100000 = 0.4
      principalInr: 10000,
      tenureMonths: 12,
      basePenaltyPct: 0.25
    });
    expect(penalty).toBe(0);
  });

  it('should apply base penalty scaled by debt ratio (no high risk debt, no short term penalty)', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [{ liability_type: 'HOME_LOAN', outstanding_principal: '80000' }],
      totalLiabilitiesInr: 80000,
      totalAssetsInr: 10000, // Ratio: 80000 / (10000 + 10000) = 80000 / 20000 = 4.0
      principalInr: 10000,
      tenureMonths: 24,
      basePenaltyPct: 0.25
    });
    
    // Multiplier calculation:
    // base multiplier = 1.0
    // debtRatio = 4.0
    // highRiskDebt = 0
    // isShortTerm = false (tenure 24 >= 12)
    // isLongTerm = false (tenure 24 <= 36)
    // finalMultiplier = 2.0
    // penalty = 0.25 * 2.0 = 0.5
    
    expect(penalty).toBe(0.5);
  });

  it('should apply higher penalty for high risk debt', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [{ liability_type: 'CREDIT_CARD_OUTSTANDING', outstanding_principal: '80000' }],
      totalLiabilitiesInr: 80000,
      totalAssetsInr: 10000, // Ratio: 4.0
      principalInr: 10000,
      tenureMonths: 24,
      basePenaltyPct: 0.25
    });
    
    // Multiplier calculation:
    // base = 1.0
    // highRisk => base + 0.5 = 1.5
    // highRiskDebt < 10,000,000 => no extra liquidity risk
    // multiplier = 2.5
    // penalty = 0.25 * 2.5 = 0.625
    
    expect(penalty).toBe(0.625);
  });

  it('should apply extreme penalty for huge high-risk debt', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [{ liability_type: 'PERSONAL_LOAN', outstanding_principal: '15000000' }],
      totalLiabilitiesInr: 15000000,
      totalAssetsInr: 100000, // Ratio: 15000000 / 200000 = 75.0
      principalInr: 100000,
      tenureMonths: 24,
      basePenaltyPct: 0.25
    });
    
    // Multiplier calculation:
    // base = 1.0
    // highRisk => base + 0.5 = 1.5
    // highRiskDebt = 15000000 > 10,000,000 => base + 1.0 = 2.5
    // multiplier = 3.5
    // penalty = 0.25 * 3.5 = 0.875
    
    expect(penalty).toBe(0.875);
  });

  it('should apply short term liquidity mismatch penalty', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [{ liability_type: 'HOME_LOAN', outstanding_principal: '80000' }],
      totalLiabilitiesInr: 80000,
      totalAssetsInr: 10000, // Ratio: 4.0
      principalInr: 10000,
      tenureMonths: 6, // Short term
      basePenaltyPct: 0.25
    });
    
    // Multiplier:
    // base = 1.0
    // isShortTerm => base * 1.2 = 1.2
    // multiplier = 1.2 * 2.0 = 2.4
    // penalty = 0.25 * 2.4 = 0.6
    
    expect(penalty).toBeCloseTo(0.6);
  });

  it('should reduce penalty for long term deposits', () => {
    const penalty = AlmPolicyEngine.calculatePenalty({
      liabilities: [{ liability_type: 'HOME_LOAN', outstanding_principal: '80000' }],
      totalLiabilitiesInr: 80000,
      totalAssetsInr: 10000, // Ratio: 4.0
      principalInr: 10000,
      tenureMonths: 48, // Long term
      basePenaltyPct: 0.25
    });
    
    // Multiplier:
    // base = 1.0
    // isLongTerm => base * 0.8 = 0.8
    // multiplier = 0.8 * 2.0 = 1.6
    // penalty = 0.25 * 1.6 = 0.4
    
    expect(penalty).toBeCloseTo(0.4);
  });
});
