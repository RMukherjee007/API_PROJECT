const request = require('supertest');
const jwt = require('jsonwebtoken');

// Set env vars before requiring app
process.env.NODE_ENV = 'test';
process.env.HMAC_SHARED_SECRET = 'test-hmac-secret-32-bytes-long';
process.env.JWT_SECRET = 'test-jwt-secret-32-bytes-long';
process.env.CBS_CACHE_TTL_SECONDS = '120';
process.env.RATE_LIMIT_MAX = '1000';
process.env.REDIS_ENABLED = 'false';

// We mock safeFetch to avoid real network calls
jest.mock('../shared/utils/helpers', () => {
  const original = jest.requireActual('../shared/utils/helpers');
  return {
    ...original,
    safeFetch: jest.fn(),
  };
});
const { buildSigningString } = require('../shared/middleware/auth');
const { safeFetch, hmacSha256Hex, sha256Hex } = require('../shared/utils/helpers');
const config = require('../shared/config');
const app = require('./index');

describe('Gateway Service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Health Endpoints', () => {
    it('returns 200 for /health/live', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 200 for /health/ready when downstream is up', async () => {
      safeFetch.mockResolvedValue({ ok: true, status: 200 });
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks.yield_engine.status).toBe('reachable');
    });

    it('returns 503 for /health/ready when yield_engine is down', async () => {
      safeFetch.mockRejectedValueOnce(new Error('Connection refused')); // yield-engine fails
      safeFetch.mockResolvedValue({ ok: true, status: 200 }); // others succeed
      
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.checks.yield_engine.status).toBe('unreachable');
    });
  });

  describe('Auth Proxies', () => {
    it('proxies /auth/login successfully', async () => {
      safeFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ status: 'success', user: {} }),
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'test', password: 'pwd' });

      expect(res.status).toBe(200);
      expect(safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/auth/login'),
        expect.objectContaining({ method: 'POST' }),
        expect.any(Object)
      );
    });
  });

  describe('Protected API Proxies', () => {
    it('rejects /rates without JWT and HMAC', async () => {
      const res = await request(app).get('/rates');
      expect(res.status).toBe(401);
    });

    it('allows /rates with valid JWT and HMAC', async () => {
      safeFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ rate: '1.2' }),
      });

      const token = jwt.sign({ sub: 'EMP1', role: 'RM' }, config.security.jwtSecret, {
        issuer: config.security.jwtIssuer,
        audience: config.security.jwtAudience,
      });

      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(config.security.hmacSecret, buildSigningString(ts, 'GET', '/rates', bodyHash));

      const res = await request(app)
        .get('/rates')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-User-Role', 'RM');

      expect(res.status).toBe(200);
      expect(safeFetch).toHaveBeenCalled();
    });
  });

  describe('POST /optimize Orchestrator', () => {
    let validHeaders;
    
    beforeEach(() => {
      const token = jwt.sign({ sub: 'EMP1', role: 'ADMIN' }, config.security.jwtSecret, {
        issuer: config.security.jwtIssuer,
        audience: config.security.jwtAudience,
      });

      const body = { customer_id: '123' };
      const ts = Date.now().toString();
      const bodyHash = sha256Hex(JSON.stringify(body));
      const sig = hmacSha256Hex(config.security.hmacSecret, buildSigningString(ts, 'POST', '/optimize', bodyHash));

      validHeaders = {
        'Authorization': `Bearer ${token}`,
        'X-Gateway-Timestamp': ts,
        'X-Internal-Signature': sig,
        'X-User-Role': 'ADMIN',
        'X-Employee-Id': 'EMP1',
        'Idempotency-Key': 'test-idem-key-' + Date.now(),
      };
    });

    it('rejects if customer_id is missing', async () => {
      const body = {};
      const ts = Date.now().toString();
      const bodyHash = sha256Hex(JSON.stringify(body));
      const sig = hmacSha256Hex(config.security.hmacSecret, buildSigningString(ts, 'POST', '/optimize', bodyHash));
      
      const res = await request(app)
        .post('/optimize')
        .set({ ...validHeaders, 'X-Gateway-Timestamp': ts, 'X-Internal-Signature': sig, 'Idempotency-Key': '1234567890' })
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('fetches portfolio and forwards to yield-engine', async () => {
      // Mock portfolio fetch (bank adapter)
      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ assets: [{ type: 'NRE', balance: 1000 }], liabilities: [] })
      });

      // Mock yield-engine optimize
      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ optimized: true }),
        headers: new Map([['content-type', 'application/json']]),
      });

      const res = await request(app)
        .post('/optimize')
        .set(validHeaders)
        .send({ customer_id: '123' });

      expect(res.status).toBe(200);
      expect(res.headers['x-portfolio-source']).toBe('CBS_FETCH');
      expect(safeFetch).toHaveBeenCalledTimes(2);
      
      // Ensure the second call (yield-engine) contains the fetched portfolio
      const yieldEngineCall = safeFetch.mock.calls[1];
      expect(yieldEngineCall[0]).toContain('/optimize');
      const forwardedBody = JSON.parse(yieldEngineCall[1].body);
      expect(forwardedBody.assets).toHaveLength(1);
    });

    it('falls back to provided portfolio if upstream fails', async () => {
      // Bank adapter and ESB both fail
      safeFetch.mockRejectedValueOnce(new Error('Bank Down')); 
      safeFetch.mockRejectedValueOnce(new Error('ESB Down'));

      const res = await request(app)
        .post('/optimize')
        .set(validHeaders)
        .send({ customer_id: '123' });

      // The gateway should return 503 DEPENDENCY_TIMEOUT if it can't fetch portfolio and none provided.
      expect(res.status).toBe(503);
      expect(res.body.error_code).toBe('DEPENDENCY_TIMEOUT');
    });
  });
});
