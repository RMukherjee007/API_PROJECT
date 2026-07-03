const crypto = require('crypto');
require('dotenv').config();

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const HMAC_SHARED_SECRET = process.env.HMAC_SHARED_SECRET;

if (!HMAC_SHARED_SECRET) {
    console.error('HMAC_SHARED_SECRET is required to run API tests.');
    process.exit(1);
}

function sha256Hex(message) {
    return crypto.createHash('sha256').update(message).digest('hex');
}

function computeHMAC(secret, message) {
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

async function runTests() {
    let failed = 0;
    
    // Login to get tokens
    let authTokenRM = '';
    let authTokenSenior = '';
    try {
        const loginResRM = await fetch(`${GATEWAY_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'rm.test@csb.co.in', password: 'password123' })
        });
        authTokenRM = (await loginResRM.json()).access_token;
        
        const loginResSenior = await fetch(`${GATEWAY_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'senior.rm.test@csb.co.in', password: 'password123' })
        });
        authTokenSenior = (await loginResSenior.json()).access_token;
        
        if (!authTokenRM || !authTokenSenior) {
            console.error('Failed to get JWT tokens for tests');
            process.exit(1);
        }
        console.log('Successfully obtained test JWT tokens');
    } catch (e) {
        console.error('Login request failed', e);
        process.exit(1);
    }
    
    // Helper to send request
    async function sendRequest(path, payload, headers = {}, method = 'POST') {
        const timestamp = headers['X-Gateway-Timestamp'] || Date.now().toString();
        const idempKey = headers['Idempotency-Key'] || 'idemp-' + Math.random().toString(36).substr(2, 9);
        const role = headers['X-User-Role'] || 'RM';
        const empId = headers['X-Employee-ID'] || (role === 'SENIOR_RM' ? 'EMP002' : 'EMP001');
        
        const authToken = (role === 'SENIOR_RM' || role === 'TREASURY') ? authTokenSenior : authTokenRM;
        
        const bodyString = payload ? JSON.stringify(payload) : '';
        const bodyHash = sha256Hex(bodyString);
        const signedPath = path.split('?')[0];
        
        const signingString = `${timestamp}|${method}|${signedPath}|${bodyHash}`;
        const signature = headers['X-Internal-Signature'] !== undefined ? headers['X-Internal-Signature'] : computeHMAC(HMAC_SHARED_SECRET, signingString);
        
        const finalHeaders = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
            ...headers
        };
        // The Gateway ignores these internal headers if coming from outside, but we might test internal routes directly
        if (signature !== null) {
            finalHeaders['X-Internal-Signature'] = signature;
            finalHeaders['X-Gateway-Timestamp'] = timestamp;
            finalHeaders['X-User-Role'] = role;
            finalHeaders['X-Employee-ID'] = empId;
        }
        if (payload && !finalHeaders['Idempotency-Key']) {
            finalHeaders['Idempotency-Key'] = idempKey;
        }
        
        try {
            const response = await fetch(`${GATEWAY_URL}${path}`, {
                method,
                headers: finalHeaders,
                body: payload ? bodyString : undefined
            });
            const status = response.status;
            const text = await response.text();
            let data = null;
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = text;
            }
            return { status, data, headers: response.headers };
        } catch (e) {
            return { status: 500, error: e.message };
        }
    }

    console.log('--- STARTING API AND LOGIC TESTS ---');

    // Test 1: Successful recommendation calculation
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const res = await sendRequest('/optimize', payload);
        if (res.status === 200 && res.data.advisory.recommended_product) {
            console.log('PASS: Test 1 - Successful request');
            // Check formatted string yields
            if (typeof res.data.decision_trace.fcnr_effective_yield_pct === 'string' &&
                /^-?\d+\.\d{2,4}$/.test(res.data.decision_trace.fcnr_effective_yield_pct)) {
                console.log('PASS: FCNR effective yield is formatted decimal string:', res.data.decision_trace.fcnr_effective_yield_pct);
            } else {
                console.log('FAIL: FCNR yield is not formatted decimal string:', res.data.decision_trace.fcnr_effective_yield_pct);
                failed++;
            }
        } else {
            console.log('FAIL: Test 1 - Successful request failed', res);
            failed++;
        }
    }

    // Test 2: Invalid signature
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const res = await sendRequest('/optimize', payload, { 'X-Internal-Signature': 'invalid-signature' });
        if (res.status === 401 && res.data.error_code === 'SIGNATURE_MISMATCH') {
            console.log('PASS: Test 2 - Invalid signature rejected with 401 SIGNATURE_MISMATCH');
        } else {
            console.log('FAIL: Test 2 - Invalid signature did not fail correctly', res);
            failed++;
        }
    }

    // Test 3: Stale timestamp
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const staleTimestamp = (Date.now() - 40000).toString(); // 40 seconds ago
        const res = await sendRequest('/optimize', payload, { 'X-Gateway-Timestamp': staleTimestamp });
        if (res.status === 401 && res.data.error_code === 'TIMESTAMP_SKEW') {
            console.log('PASS: Test 3 - Stale timestamp rejected with 401 TIMESTAMP_SKEW');
        } else {
            console.log('FAIL: Test 3 - Stale timestamp did not fail correctly', res);
            failed++;
        }
    }

    // Test 4: RM trying to override
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001',
            market_rates_override: {
                fcnr_rate_pct: '5.50',
                override_reason: 'Negotiated high yield with client during branch visit today. Customer is very sensitive to FCNR interest rates.'
            }
        };
        const res = await sendRequest('/optimize', payload, { 'X-User-Role': 'RM' });
        if (res.status === 403 && res.data.error_code === 'INSUFFICIENT_ROLE') {
            console.log('PASS: Test 4 - RM override request blocked with 403 INSUFFICIENT_ROLE');
        } else {
            console.log('FAIL: Test 4 - RM override did not fail correctly', res);
            failed++;
        }
    }

    // Test 5: GCC requires GIFT branch code
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'AED', // GCC Currency
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'BOM-001' // Non-IFSC branch
        };
        const res = await sendRequest('/optimize', payload);
        if (res.status === 422 && res.data.error_code === 'GCC_REQUIRES_IFSC_BRANCH') {
            console.log('PASS: Test 5 - GCC currency without GIFT branch rejected with 422 GCC_REQUIRES_IFSC_BRANCH');
        } else {
            console.log('FAIL: Test 5 - GCC branch check failed', res);
            failed++;
        }
    }

    // Test 6: FCNR Tenure out of range
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 6, // FCNR minimum is 12 months
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const res = await sendRequest('/optimize', payload);
        if (res.status === 422 && res.data.error_code === 'TENURE_OUT_OF_RANGE') {
            console.log('PASS: Test 6 - Tenure out of range rejected with 422 TENURE_OUT_OF_RANGE');
        } else {
            console.log('FAIL: Test 6 - Tenure check failed', res);
            failed++;
        }
    }

    // Test 7: Principal too low
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '500.00', // Below USD 1,000 FCNR min
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const res = await sendRequest('/optimize', payload);
        if (res.status === 422 && res.data.error_code === 'PRINCIPAL_BELOW_MINIMUM') {
            console.log('PASS: Test 7 - Principal too low rejected with 422 PRINCIPAL_BELOW_MINIMUM');
        } else {
            console.log('FAIL: Test 7 - Principal check failed', res);
            failed++;
        }
    }

    // Test 8: Value date in past
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: '2020-01-01', // Past date
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const res = await sendRequest('/optimize', payload);
        if (res.status === 422 && res.data.error_code === 'VALUE_DATE_IN_PAST') {
            console.log('PASS: Test 8 - Value date in past rejected with 422 VALUE_DATE_IN_PAST');
        } else {
            console.log('FAIL: Test 8 - Past date check failed', res);
            failed++;
        }
    }

    // Test 9: Override deviation cap exceeded
    {
        const payload = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001',
            market_rates_override: {
                fcnr_rate_pct: '15.50', // Too high (+1030 bps above 5.20)
                override_reason: 'Highly exceptional VIP customer with major global wealth deposits negotiated today. Yield approved by Senior leadership.'
            }
        };
        const res = await sendRequest('/optimize', payload, { 'X-User-Role': 'SENIOR_RM' });
        if (res.status === 422 && res.data.error_code === 'RATE_OVERRIDE_LIMIT_EXCEEDED') {
            console.log('PASS: Test 9 - Senior RM override still respects deviation cap');
        } else {
            console.log('FAIL: Test 9 - Expected deviation cap rejection', res);
            failed++;
        }
    }

    // Test 10: Idempotency Key collision
    {
        const key = 'collision-idemp-' + Math.random().toString(36).substr(2, 9);
        const payload1 = {
            customer_id: 'CUST123',
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        const payload2 = {
            customer_id: 'CUST123',
            risk_profile: 'CONSERVATIVE', // different parameter
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001'
        };
        
        const res1 = await sendRequest('/optimize', payload1, { 'Idempotency-Key': key });
        const res2 = await sendRequest('/optimize', payload2, { 'Idempotency-Key': key });
        
        if (res1.status === 200 && res2.status === 409 && res2.data.error_code === 'IDEMPOTENCY_CONFLICT') {
            console.log('PASS: Test 10 - Idempotency conflict detected and returned 409');
        } else {
            console.log('FAIL: Test 10 - Idempotency collision check failed', res1.status, res2.status, res2.data);
            failed++;
        }
    }

    // Test 11: Real yield Fisher math correctness (with dynamic overrides matching live spot to avoid deviation limits)
    {
        const ratesRes = await sendRequest('/rates', null, {}, 'GET');
        const liveSpot = parseFloat((ratesRes.data && ratesRes.data.fx_spot_rates && ratesRes.data.fx_spot_rates['USD/INR']) || '83.50');
        const payload = {
            customer_id: 'CUST_EMPTY', // Use empty customer to avoid pulling CBS portfolio which alters ALM penalty
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001',
            india_inflation_rate: '4.50',
            foreign_inflation_rate: '2.00',
            fx_rate_overrides: {
                product_spot_rate: liveSpot.toFixed(4),
                forward_rates: {
                    '36': (liveSpot * (86.50 / 83.50)).toFixed(4)
                }
            }
        };
        const res = await sendRequest('/optimize', payload, { 'X-User-Role': 'SENIOR_RM' });
        if (res.status === 200 && res.data.decision_trace.calculation_method === 'REAL_PPP_ADJUSTED') {
            const fcnrReal = parseFloat(res.data.decision_trace.fcnr_real_yield_pct);
            const nreReal = parseFloat(res.data.decision_trace.nre_real_yield_pct);
            
            // FCNR USD = 5.20%. ALM penalty is applied because principal (50k USD) > 0 assets.
            // Penalty = 0.35%.
            // Nominal FCNR effective yield = 5.20% - 0.35% = 4.85%.
            // Foreign Inflation = 2.00%.
            // PPP FCNR real yield = (1.0485 / 1.0200) - 1 = 0.02794 = 2.79%
            // In NRE: Nominal NRE = 7.25%. Spot = 83.50, Fwd = 86.50 (for 36m).
            // T = 3.
            // FX-adjusted NRE = (( (1.0725)^3 * (83.50 / 86.50) )^(1/3) - 1) * 100
            // (1.0725)^3 = 1.233543
            // 1.233543 * (83.50 / 86.50) = 1.233543 * 0.9653179 = 1.190761
            // 1.190761^(1/3) = 1.0599
            // FX-adjusted NRE yield = 5.99%
            // Fisher NRE real yield = (1.0599 / 1.0450) - 1 = 1.43%
            
            if (fcnrReal.toFixed(2) === '2.79' && nreReal.toFixed(2) === '1.43') {
                console.log(`PASS: Test 11 - PPP yields are mathematically correct! (FCNR real: ${fcnrReal}%, NRE real: ${nreReal}%)`);
                
                // Test 12: Retrieve recommendation by ID (GET /recommendations/:id)
                const recId = res.data.metadata.recommendation_id;
                const recRes = await sendRequest(`/recommendations/${recId}`, null, { 'X-User-Role': 'SENIOR_RM' }, 'GET');
                if (recRes.status === 200 && recRes.data.metadata.recommendation_id === recId) {
                    console.log('PASS: Test 12 - Retrieve recommendation by ID successful');
                } else {
                    console.log('FAIL: Test 12 - Retrieve recommendation failed', recRes);
                    failed++;
                }
                const reportRes = await sendRequest(`/reports/${recId}`, null, { 'X-User-Role': 'SENIOR_RM' }, 'GET');
                if (reportRes.status === 200 && String(reportRes.headers.get('content-type') || '').includes('application/pdf')) {
                    console.log('PASS: Test 12b - Downloadable recommendation report successful');
                } else {
                    console.log('FAIL: Test 12b - Report download failed', reportRes.status, reportRes.headers && reportRes.headers.get('content-type'));
                    failed++;
                }
            } else {
                console.log(`FAIL: Test 11 - PPP yields mathematical mismatch. Expected FCNR 2.79% (got ${fcnrReal}%), NRE 1.43% (got ${nreReal}%)`);
                failed++;
            }
        } else {
            console.log('FAIL: Test 11 - Expected REAL_PPP_ADJUSTED calculation method', res);
            failed++;
        }
    }

    // Test 13: Rates endpoint (GET /rates)
    {
        const res = await sendRequest('/rates', null, {}, 'GET');
        if (res.status === 200 && res.data.policy_version && res.data.fcnr_rates) {
            console.log('PASS: Test 13 - Rates retrieval successful');
        } else {
            console.log('FAIL: Test 13 - Rates retrieval failed', res);
            failed++;
        }
    }

    // Test 14: Client-provided portfolio and ALM penalty application (with dynamic overrides matching live spot)
    {
        const ratesRes = await sendRequest('/rates', null, {}, 'GET');
        const liveSpot = parseFloat((ratesRes.data && ratesRes.data.fx_spot_rates && ratesRes.data.fx_spot_rates['USD/INR']) || '83.50');
        const payload = {
            customer_id: 'CUST_EMPTY', // Use empty customer to avoid pulling CBS portfolio which alters ALM penalty
            risk_profile: 'MODERATE',
            principal_amount: '50000.00',
            base_currency: 'USD',
            value_date: new Date().toISOString().split('T')[0],
            tenure_months: 36,
            channel: 'BRANCH',
            branch_code: 'GIFT-001',
            fx_rate_overrides: {
                product_spot_rate: liveSpot.toFixed(4),
                forward_rates: {
                    '36': (liveSpot * (86.50 / 83.50)).toFixed(4)
                },
                portfolio_cross_rates: {
                    'USD/INR': liveSpot.toFixed(4)
                }
            },
            assets: [
                { market_value: '10000.00', currency: 'USD', asset_type: 'SAVINGS_ACCOUNT' }
            ],
            liabilities: [
                { outstanding_principal: '20000.00', currency: 'USD', liability_type: 'HOME_LOAN' }
            ]
        };
        const res = await sendRequest('/optimize', payload, { 'X-User-Role': 'SENIOR_RM' });
        if (res.status === 200) {
            const trace = res.data.decision_trace;
            // netMismatchRatio = (60k - 10k) / 60k = 5/6 = 0.8333.
            // penalty = 0.35 * 0.8333 = 0.2916 -> 0.29%
            if (trace.alm_penalty_applied === true && trace.alm_penalty_pct === "0.29") {
                // FCNR nominal base is 5.20%. With 29 bps penalty, effective yield should be 5.20 - 0.29 = 4.91%
                const effectiveFcnr = parseFloat(trace.fcnr_effective_yield_pct);
                if (effectiveFcnr === 4.91) {
                    console.log('PASS: Test 14 - Client-provided portfolio and ALM penalty applied correctly!');
                } else {
                    console.log(`FAIL: Test 14 - Expected FCNR effective yield of 4.91%, got ${trace.fcnr_effective_yield_pct}`);
                    failed++;
                }
            } else {
                console.log('FAIL: Test 14 - ALM penalty was not applied as expected', trace);
                failed++;
            }
        } else {
            console.log('FAIL: Test 14 - Request failed', res);
            failed++;
        }
    }

    // Test 15: Suggestion history endpoint
    {
        const res = await sendRequest('/history?limit=10', null, {}, 'GET');
        if (res.status === 200 && Array.isArray(res.data.items)) {
            console.log('PASS: Test 15 - Suggestion history retrieval successful');
        } else {
            console.log('FAIL: Test 15 - Suggestion history retrieval failed', res);
            failed++;
        }
    }

    console.log('--- TESTS SUMMARY ---');
    if (failed === 0) {
        console.log('ALL TESTS PASSED SUCCESSFULLY! 🎉');
    } else {
        console.log(`${failed} TEST(S) FAILED. ❌`);
        process.exit(1);
    }
}

async function runInternalSecurityTests() {
    // --- INTERNAL SECURITY TESTS (Hitting Yield Engine directly) ---
    console.log('\n--- INTERNAL SECURITY TESTS ---');
    const YIELD_ENGINE_URL = 'http://localhost:8082';
    async function sendInternalRequest(path, payload, headers = {}, method = 'POST') {
        const timestamp = headers['X-Gateway-Timestamp'] || Date.now().toString();
        const role = headers['X-User-Role'] || 'RM';
        const empId = headers['X-Employee-ID'] || 'EMP123';
        
        const bodyString = payload ? JSON.stringify(payload) : '';
        const bodyHash = sha256Hex(bodyString);
        const signedPath = path.split('?')[0];
        
        const signingString = `${timestamp}|${method}|${signedPath}|${bodyHash}`;
        let signature;
        if ('X-Internal-Signature' in headers) {
            signature = headers['X-Internal-Signature'];
        } else {
            signature = computeHMAC(HMAC_SHARED_SECRET, signingString);
        }
        
        const finalHeaders = {
            'Content-Type': 'application/json',
            'X-Gateway-Timestamp': timestamp,
            'X-User-Role': role,
            'X-Employee-ID': empId,
            ...headers
        };
        if (signature !== null && signature !== undefined) {
            finalHeaders['X-Internal-Signature'] = signature;
        } else {
            delete finalHeaders['X-Internal-Signature'];
        }
        
        try {
            const response = await fetch(`${YIELD_ENGINE_URL}${path}`, {
                method,
                headers: finalHeaders,
                body: payload ? bodyString : undefined
            });
            const status = response.status;
            let data = null;
            const text = await response.text();
            try { data = JSON.parse(text); } catch { data = text; }
            return { status, data };
        } catch (e) {
            return { status: 500, error: e.message };
        }
    }

    const testPayload = {
        customer_id: 'CUST_EMPTY',
        risk_profile: 'MODERATE',
        principal_amount: '50000.00',
        base_currency: 'USD',
        value_date: new Date().toISOString().split('T')[0],
        tenure_months: 36,
        channel: 'BRANCH',
        branch_code: 'GIFT-001'
    };

    let internalFailed = 0;

    // Internal Test 1: Missing signature (unsigned)
    {
        const res = await sendInternalRequest('/optimize', testPayload, { 'X-Internal-Signature': undefined });
        if (res.status === 401 && res.data.error_code === 'MISSING_SIGNATURE') {
            console.log('PASS: Internal Test 1 - Unsigned internal call rejected');
        } else {
            console.log('FAIL: Internal Test 1 - Unsigned call was not rejected properly', res.status, res.data);
            internalFailed++;
        }
    }

    // Internal Test 2: Bad signature
    {
        const res = await sendInternalRequest('/optimize', testPayload, { 'X-Internal-Signature': 'bad-signature' });
        if (res.status === 401 && res.data.error_code === 'SIGNATURE_MISMATCH') {
            console.log('PASS: Internal Test 2 - Bad signature internal call rejected');
        } else {
            console.log('FAIL: Internal Test 2 - Bad signature call was not rejected properly', res.status, res.data);
            internalFailed++;
        }
    }

    // Internal Test 3: Stale timestamp
    {
        const staleTimestamp = (Date.now() - 40000).toString();
        const res = await sendInternalRequest('/optimize', testPayload, { 'X-Gateway-Timestamp': staleTimestamp });
        if (res.status === 401 && res.data.error_code === 'TIMESTAMP_SKEW') {
            console.log('PASS: Internal Test 3 - Stale timestamp internal call rejected');
        } else {
            console.log('FAIL: Internal Test 3 - Stale timestamp call was not rejected properly', res.status, res.data);
            internalFailed++;
        }
    }

    // Internal Test 4: Gateway-signed call succeeds
    {
        const res = await sendInternalRequest('/optimize', testPayload);
        if (res.status === 200) {
            console.log('PASS: Internal Test 4 - Valid gateway-signed internal call succeeded');
        } else {
            console.log('FAIL: Internal Test 4 - Valid signed call failed', res.status, res.data);
            internalFailed++;
        }
    }

    console.log('--- FINAL INTERNAL TESTS SUMMARY ---');
    if (internalFailed === 0) {
        console.log('ALL INTERNAL TESTS PASSED SUCCESSFULLY! 🚀');
    } else {
        console.log(`${internalFailed} INTERNAL TEST(S) FAILED. ❌`);
        process.exit(1);
    }
}

runTests().then(runInternalSecurityTests);
