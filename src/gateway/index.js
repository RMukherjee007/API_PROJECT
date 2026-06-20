const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ESB_URL = process.env.ESB_URL || 'http://localhost:8081';
const MICROSERVICE_URL = process.env.MICROSERVICE_URL || 'http://localhost:8082';

const HMAC_SHARED_SECRET = process.env.HMAC_SHARED_SECRET || 'local-test-secret-change-me';

// IN-MEMORY CACHE (Replaces Redis for local testing without Docker)
const cache = new Map();

function newTraceparent() {
    const traceId = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    return `00-${traceId}-00f067aa0ba902b7-01`;
}

// RFC 7807 error helper
function sendError(res, status, errorCode, detail, traceparent, invalidFields = null) {
    const type = `https://api.bank.com/errors/${errorCode.toLowerCase().replace(/_/g, '-')}`;
    const title = errorCode.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    const body = {
        type,
        title,
        status,
        detail,
        instance: traceparent || `00-${crypto.randomUUID().replace(/-/g, '')}-0000000000000000-01`,
        error_code: errorCode
    };
    if (invalidFields) {
        body.invalid_fields = invalidFields;
    }
    return res.status(status).type('application/problem+json').json(body);
}

// Middleware: Authentication, RBAC, HMAC & Idempotency Check
const validateRequest = async (req, res, next) => {
    const traceparent = req.headers['traceparent'] || newTraceparent();
    req.traceparent = traceparent;

    // 1. Gateway Timestamp Skew
    const timestamp = req.headers['x-gateway-timestamp'];
    if (!timestamp) {
        return sendError(res, 401, 'TIMESTAMP_SKEW', 'Missing X-Gateway-Timestamp header.', traceparent);
    }
    const tsNum = parseInt(timestamp, 10);
    if (Number.isNaN(tsNum) || Math.abs(Date.now() - tsNum) > 30000) {
        return sendError(res, 401, 'TIMESTAMP_SKEW', 'X-Gateway-Timestamp deviates more than ±30 seconds from server time.', traceparent);
    }

    // 2. HMAC Signature verification
    const signature = req.headers['x-internal-signature'];
    if (!signature) {
        return sendError(res, 401, 'SIGNATURE_MISMATCH', 'Missing X-Internal-Signature header.', traceparent);
    }

    const bodyString = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : '';
    const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');
    const signingString = `${timestamp}|${req.method}|${req.path}|${bodyHash}`;
    const expectedSignature = crypto.createHmac('sha256', HMAC_SHARED_SECRET).update(signingString).digest('hex');

    try {
        const sigBuffer = Buffer.from(signature, 'hex');
        const expBuffer = Buffer.from(expectedSignature, 'hex');
        if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
            return sendError(res, 401, 'SIGNATURE_MISMATCH', 'X-Internal-Signature HMAC validation failed.', traceparent);
        }
    } catch (e) {
        return sendError(res, 401, 'SIGNATURE_MISMATCH', 'X-Internal-Signature HMAC validation failed.', traceparent);
    }

    // 3. Session / role injection
    const role = req.headers['x-user-role'] || 'RM';
    const employeeId = req.headers['x-employee-id'] || 'EMP123';
    req.userRole = role;
    req.employeeId = employeeId;

    if (!['RM', 'SENIOR_RM', 'TREASURY'].includes(role)) {
        return sendError(res, 403, 'INSUFFICIENT_ROLE', `Role "${role}" is not authorized.`, traceparent);
    }

    // Only apply RBAC overrides check & Idempotency check for POST /optimize
    if (req.method === 'POST' && req.path === '/optimize') {
        // 4. RBAC Check for Overrides
        const hasOverride = req.body && (req.body.fx_rate_overrides || req.body.market_rates_override);
        if (hasOverride && role === 'RM') {
            return sendError(res, 403, 'INSUFFICIENT_ROLE', 'RM role cannot submit fx_rate_overrides or market_rates_override.', traceparent);
        }

        // 5. Idempotency Check
        const idempotencyKey = req.headers['idempotency-key'];
        if (!idempotencyKey) {
            return sendError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing Idempotency-Key header.', traceparent, { 'Idempotency-Key': 'is required' });
        }

        const cacheKey = `idemp:${idempotencyKey}`;
        const cachedResponse = cache.get(cacheKey);

        if (cachedResponse) {
            if (cachedResponse.status === 'pending') {
                return sendError(res, 409, 'IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is already in progress.', traceparent);
            }
            if (cachedResponse.bodyHash !== bodyHash) {
                return sendError(res, 409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT: Key reused with different body.', traceparent);
            }
            res.setHeader('X-Idempotency-Replay', 'true');
            if (cachedResponse.portfolioSource) {
                res.setHeader('X-Portfolio-Source', cachedResponse.portfolioSource);
            }
            if (cachedResponse.cacheAge !== undefined) {
                res.setHeader('X-Portfolio-Cache-Age-Seconds', String(cachedResponse.cacheAge));
            }
            return res.status(200).json(cachedResponse.response);
        }

        // Set state to pending to prevent race condition
        cache.set(cacheKey, { status: 'pending', bodyHash });
        req.idempKey = cacheKey;
        req.idempHash = bodyHash;
    }

    next();
};

app.post('/optimize', validateRequest, async (req, res) => {
    const customerId = req.body.customer_id;
    const traceparent = req.traceparent;

    if (!customerId) {
        if (req.idempKey) cache.delete(req.idempKey);
        return sendError(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing customer_id.', traceparent, { customer_id: 'is required' });
    }

    let portfolioSource = 'CLIENT_INPUT';
    let cacheAge = 0;
    let portfolioData = {
        assets: (req.body && req.body.assets) || [],
        liabilities: (req.body && req.body.liabilities) || []
    };

    // Normalize assets and liabilities to 2 decimal places to match schema regex
    if (portfolioData.assets) {
        portfolioData.assets = portfolioData.assets.map(a => ({
            ...a,
            market_value: a.market_value !== undefined ? parseFloat(a.market_value).toFixed(2) : undefined
        }));
    }
    if (portfolioData.liabilities) {
        portfolioData.liabilities = portfolioData.liabilities.map(l => ({
            ...l,
            outstanding_principal: l.outstanding_principal !== undefined ? parseFloat(l.outstanding_principal).toFixed(2) : undefined
        }));
    }

    const fatPayload = { ...req.body, ...portfolioData };

    const headersToForward = {
        'Content-Type': 'application/json',
        'traceparent': traceparent,
        'X-Employee-ID': req.employeeId,
        'X-User-Role': req.userRole,
        'X-Portfolio-Source': portfolioSource
    };

    if (portfolioSource === 'CACHE_HIT') {
        headersToForward['X-Portfolio-Cache-Age-Seconds'] = cacheAge.toString();
    }

    try {
        console.log(`[Gateway] Forwarding enriched payload to Math Microservice...`);
        const microserviceResponse = await fetch(`${MICROSERVICE_URL}/optimize`, {
            method: 'POST',
            headers: headersToForward,
            body: JSON.stringify(fatPayload)
        });

        const msData = await microserviceResponse.json();

        if (microserviceResponse.ok) {
            // Cache resolved output
            cache.set(req.idempKey, {
                status: 'resolved',
                bodyHash: req.idempHash,
                response: msData,
                portfolioSource,
                cacheAge
            });
            setTimeout(() => cache.delete(req.idempKey), 86400 * 1000); // 24h TTL

            res.setHeader('X-Portfolio-Source', portfolioSource);
            if (portfolioSource === 'CACHE_HIT') {
                res.setHeader('X-Portfolio-Cache-Age-Seconds', cacheAge.toString());
            }
            return res.status(200).json(msData);
        } else {
            // Remove pending cache entry on business errors
            cache.delete(req.idempKey);
            return res.status(microserviceResponse.status).type('application/problem+json').json(msData);
        }
    } catch (err) {
        console.error("[Gateway] Error calling microservice:", err.message);
        cache.delete(req.idempKey);
        return sendError(res, 503, 'DEPENDENCY_TIMEOUT', 'The yield computation microservice is unreachable.', traceparent);
    }
});

// GET /recommendations/:recommendation_id
app.get('/recommendations/:recommendation_id', validateRequest, async (req, res) => {
    const traceparent = req.traceparent;
    try {
        const upstream = await fetch(`${MICROSERVICE_URL}/recommendations/${encodeURIComponent(req.params.recommendation_id)}`, {
            headers: {
                traceparent,
                'X-Employee-ID': req.employeeId,
                'X-User-Role': req.userRole
            },
        });
        const data = await upstream.json();
        return res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/problem+json').json(data);
    } catch (err) {
        console.error('[Gateway] Error calling microservice:', err.message);
        return sendError(res, 503, 'DEPENDENCY_TIMEOUT', 'The yield computation microservice is unreachable.', traceparent);
    }
});

// GET /rates
app.get('/rates', validateRequest, async (req, res) => {
    const traceparent = req.traceparent;
    try {
        const upstream = await fetch(`${MICROSERVICE_URL}/rates`, {
            headers: {
                traceparent,
                'X-Employee-ID': req.employeeId,
                'X-User-Role': req.userRole
            },
        });
        const data = await upstream.json();
        return res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').json(data);
    } catch (err) {
        console.error('[Gateway] Error calling microservice:', err.message);
        return sendError(res, 503, 'DEPENDENCY_TIMEOUT', 'The yield computation microservice is unreachable.', traceparent);
    }
});

app.get('/health/ready', async (req, res) => {
    try {
        const upstream = await fetch(`${MICROSERVICE_URL}/health/ready`);
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    } catch (err) {
        res.status(503).json({
            status: 'degraded',
            dependencies: {
                microservice: { status: 'error', is_critical: true, circuit_state: 'OPEN', error: err.message },
            },
        });
    }
});

app.listen(PORT, () => {
    console.log(`[Gateway] API Gateway listening on port ${PORT} (Using In-Memory Cache)`);
});
