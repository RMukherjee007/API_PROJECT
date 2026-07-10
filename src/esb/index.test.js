const request = require('supertest');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

// Set environment variables for testing
process.env.NODE_ENV = 'test';
process.env.HMAC_SHARED_SECRET = 'test-hmac-secret-32-bytes-long';
process.env.JWT_SECRET = 'test-jwt-secret-32-bytes-long';

// Mock Redis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    return {
      get: jest.fn(),
      setex: jest.fn(),
      ping: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
  });
});

const { app, redis } = require('./index');
const { hmacSha256Hex, sha256Hex } = require('../shared/utils/helpers');
const { buildSigningString } = require('../shared/middleware/auth');

describe('ESB Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Health Endpoints', () => {
    it('returns 200 for /health/live', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
    });

    it('returns 200 for /health/startup', async () => {
      const res = await request(app).get('/health/startup');
      expect(res.status).toBe(200);
    });

    it('returns 200 for /health/ready when Redis is reachable', async () => {
      redis.ping.mockResolvedValueOnce('PONG');
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks.redis).toBe('ok');
    });

    it('returns 503 for /health/ready when Redis fails', async () => {
      redis.ping.mockRejectedValueOnce(new Error('Redis connection failed'));
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.checks.redis).toBe('unreachable');
    });
  });

  describe('GET /portfolio/:customer_id', () => {
    const validHeaders = {};

    beforeEach(() => {
      const token = jwt.sign({ sub: 'EMP-1', role: 'SERVICE' }, process.env.JWT_SECRET, {
        issuer: 'test-issuer',
        audience: 'test-audience',
      });
      
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/portfolio/valid-cust-123', bodyHash));

      validHeaders['Authorization'] = `Bearer ${token}`;
      validHeaders['X-Gateway-Timestamp'] = ts;
      validHeaders['X-Internal-Signature'] = sig;
      validHeaders['X-User-Role'] = 'SERVICE';
    });

    it('rejects invalid customer ID format', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/portfolio/invalid.id', bodyHash));

      const res = await request(app)
        .get('/portfolio/invalid.id')
        .set('Authorization', validHeaders['Authorization'])
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-User-Role', 'SERVICE');

      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('INVALID_FORMAT');
    });

    it('returns cached data if available in Redis', async () => {
      const cachedData = {
        customer_id: 'valid-cust-123',
        source: 'CBS_PROXY',
        assets: [{ asset_type: 'NRE_FD', value: 1000, currency: 'USD' }],
        liabilities: []
      };

      redis.get.mockResolvedValueOnce(JSON.stringify(cachedData));

      const res = await request(app)
        .get('/portfolio/valid-cust-123')
        .set(validHeaders);

      expect(res.status).toBe(200);
      expect(res.body.customer_id).toBe('valid-cust-123');
      expect(res.body.assets).toHaveLength(1);
      
      expect(redis.get).toHaveBeenCalledWith('cbs_portfolio_cache:valid-cust-123');
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('returns placeholder and caches it on cache miss', async () => {
      redis.get.mockResolvedValueOnce(null);
      redis.setex.mockResolvedValueOnce('OK');

      const res = await request(app)
        .get('/portfolio/valid-cust-123')
        .set(validHeaders);

      expect(res.status).toBe(200);
      expect(res.body.customer_id).toBe('valid-cust-123');
      expect(res.body.source).toBe('CBS_PROXY');
      
      expect(redis.get).toHaveBeenCalledWith('cbs_portfolio_cache:valid-cust-123');
      expect(redis.setex).toHaveBeenCalledWith(
        'cbs_portfolio_cache:valid-cust-123',
        120,
        expect.any(String)
      );
    });

    it('returns 500 if Redis throws an error', async () => {
      redis.get.mockRejectedValueOnce(new Error('Redis is down'));

      const res = await request(app)
        .get('/portfolio/valid-cust-123')
        .set(validHeaders);

      expect(res.status).toBe(500);
      expect(res.body.error_code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
