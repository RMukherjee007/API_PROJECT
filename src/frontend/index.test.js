const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.HMAC_SHARED_SECRET = 'test-hmac-secret-32-bytes-long';
process.env.JWT_SECRET = 'test-jwt-secret-32-bytes-long';

// Mock safeFetch for upstream gateway proxy
jest.mock('../shared/utils/helpers', () => {
  const original = jest.requireActual('../shared/utils/helpers');
  return {
    ...original,
    safeFetch: jest.fn(),
  };
});

const { safeFetch } = require('../shared/utils/helpers');
const { app } = require('./index');

describe('Frontend Service (Gateway Proxy)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('Proxy without Token', () => {
    it('proxies request using fallback user context', async () => {
      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ status: 'ok' })),
      });

      const res = await request(app)
        .get('/api/health/live')
        .set('X-Employee-Id', 'MOCK-EMP')
        .set('X-User-Role', 'ADMIN');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      
      expect(safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/health/live'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Employee-ID': 'MOCK-EMP',
            'X-User-Role': 'ADMIN',
            'X-Internal-Signature': expect.any(String),
          })
        }),
        expect.any(Object)
      );
    });
  });

  describe('Proxy with Token', () => {
    it('rejects invalid JWT with 401', async () => {
      const res = await request(app)
        .get('/api/v1/yield/optimize')
        .set('Cookie', 'access_token=invalid.jwt.token');

      expect(res.status).toBe(401);
      expect(res.body.error_code).toBe('UNAUTHENTICATED');
    });

    it('extracts employeeId and userRole from valid JWT', async () => {
      const config = require('../shared/config');
      const token = jwt.sign({ sub: 'EMP-123', role: 'SUPER_ADMIN' }, config.security.jwtSecret, {
        issuer: config.security.jwtIssuer,
        audience: config.security.jwtAudience,
      });

      safeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ proxy: 'success' })),
      });

      const res = await request(app)
        .post('/api/v1/yield/optimize')
        .set('Cookie', `access_token=${token}`)
        .send({ amount: 1000 });

      expect(res.status).toBe(200);
      expect(res.body.proxy).toBe('success');
      
      expect(safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/yield/optimize'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Employee-ID': 'EMP-123',
            'X-User-Role': 'SUPER_ADMIN',
            'X-Internal-Signature': expect.any(String),
          })
        }),
        expect.any(Object)
      );
    });
  });

  describe('Proxy Error Handling', () => {
    it('returns 503 if gateway is unreachable', async () => {
      safeFetch.mockRejectedValueOnce(new Error('Connection Refused'));

      const res = await request(app).get('/api/v1/health');

      expect(res.status).toBe(503);
      expect(res.body.error_code).toBe('DEPENDENCY_TIMEOUT');
    });
  });
});
