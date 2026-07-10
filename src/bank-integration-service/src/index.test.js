const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.HMAC_SHARED_SECRET = 'test-hmac-secret-32-bytes-long';
process.env.JWT_SECRET = 'test-jwt-secret-32-bytes-long';

// Mock safeFetch for ESB proxy
jest.mock('../../shared/utils/helpers', () => {
  const original = jest.requireActual('../../shared/utils/helpers');
  return {
    ...original,
    safeFetch: jest.fn(),
  };
});

const { buildSigningString } = require('../../shared/middleware/auth');
const { safeFetch, hmacSha256Hex, sha256Hex } = require('../../shared/utils/helpers');
const app = require('./index');

describe('Bank Integration Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Health Endpoints', () => {
    it('returns 200 for /health/live', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 200 for /health/ready', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
    });

    it('returns 200 for /health/startup', async () => {
      const res = await request(app).get('/health/startup');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/bank/info', () => {
    it('returns service info', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/bank/info', bodyHash));
      const res = await request(app)
        .get('/api/v1/bank/info')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-User-Role', 'RM');
      expect(res.status).toBe(200);
      expect(res.body.service).toBe('bank-integration');
    });
  });

  describe('GET /api/v1/bank/cbs/portfolio/:customerId', () => {
    const validHeaders = {};
    
    beforeEach(() => {
      const token = jwt.sign({ sub: 'EMP-1', role: 'RM' }, process.env.JWT_SECRET, {
        issuer: 'test-issuer',
        audience: 'test-audience',
      });
      
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/bank/cbs/portfolio/valid-cust-123', bodyHash));

      validHeaders['Authorization'] = `Bearer ${token}`;
      validHeaders['X-Gateway-Timestamp'] = ts;
      validHeaders['X-Internal-Signature'] = sig;
      validHeaders['X-User-Role'] = 'RM';
    });

    it('rejects invalid customer ID format', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/bank/cbs/portfolio/invalid.id', bodyHash));

      const res = await request(app)
        .get('/api/v1/bank/cbs/portfolio/invalid.id')
        .set('Authorization', validHeaders['Authorization'])
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-User-Role', 'RM');
        
      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('INVALID_FORMAT');
    });

    it('proxies to ESB and normalizes successful response', async () => {
      const mockEsbResponse = {
        customer_id: 'valid-cust-123',
        assets: [
          { asset_type: 'NRE_FD', value: 10000.5, currency: 'usd' }
        ],
        liabilities: []
      };

      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockEsbResponse,
      });

      const res = await request(app)
        .get('/api/v1/bank/cbs/portfolio/valid-cust-123')
        .set(validHeaders);

      expect(res.status).toBe(200);
      expect(res.body.customer_id).toBe('valid-cust-123');
      expect(res.body.assets).toHaveLength(1);
      
      // Check normalization (currency to uppercase, value mapped to market_value)
      expect(res.body.assets[0].currency).toBe('USD');
      expect(res.body.assets[0].market_value).toBe('10000.50');
      
      expect(safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/portfolio/valid-cust-123'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('returns 502 DEPENDENCY_TIMEOUT if ESB fetch fails', async () => {
      safeFetch.mockRejectedValueOnce(new Error('Network error'));

      const res = await request(app)
        .get('/api/v1/bank/cbs/portfolio/valid-cust-123')
        .set(validHeaders);

      expect(res.status).toBe(502);
      expect(res.body.error_code).toBe('DEPENDENCY_TIMEOUT');
    });

    it('returns 502 DEPENDENCY_TIMEOUT if ESB returns non-ok status', async () => {
      safeFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal Server Error' }),
      });

      const res = await request(app)
        .get('/api/v1/bank/cbs/portfolio/valid-cust-123')
        .set(validHeaders);

      expect(res.status).toBe(502);
      expect(res.body.error_code).toBe('DEPENDENCY_TIMEOUT');
    });
  });
});
