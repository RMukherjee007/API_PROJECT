CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(36) PRIMARY KEY, -- Maps to recommendation_id UUID
    customer_id VARCHAR(50) NOT NULL,
    traceparent VARCHAR(100),
    employee_id VARCHAR(50),
    user_role VARCHAR(20),
 
    principal_amount DECIMAL(18, 2),
    base_currency VARCHAR(10),
    tenure_months INT,
    risk_profile VARCHAR(20),
    
    fcnr_rate_pct_used DECIMAL(10, 4),
    nre_rate_pct_used DECIMAL(10, 4),
    spot_rate_used DECIMAL(15, 6),
    forward_rate_used DECIMAL(15, 6),
    alm_policy_version VARCHAR(50),
    expected_inflation_rate DECIMAL(10, 4),
    
    total_assets_inr DECIMAL(18, 2),
    total_liabilities_inr DECIMAL(18, 2),
    portfolio_source VARCHAR(20),
    
    alm_penalty_bps DECIMAL(10, 4),
    fcnr_effective_yield_pct DECIMAL(10, 4),
    nre_effective_yield_pct DECIMAL(10, 4),
    calculation_method VARCHAR(30), 
    recommended_product VARCHAR(20),
    fx_risk_flag BOOLEAN,
    
    is_manual_override BOOLEAN DEFAULT FALSE,
    override_reason TEXT,
    approved_by VARCHAR(50),
    approval_timestamp DATETIME,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    
    INDEX idx_audit_customer (customer_id),
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_trace (traceparent)
);