const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.HMAC_SHARED_SECRET = 'test-hmac-secret-32-bytes-long';
process.env.JWT_SECRET = 'test-jwt-secret-32-bytes-long';

// Mock generateBulkPdfReport
jest.mock('./bulkPdfGenerator', () => ({
  generateBulkPdfReport: jest.fn().mockResolvedValue(Buffer.from('PDF_CONTENT')),
}));

// Mock AuditStore
const mockInsert = jest.fn();
const mockQuery = jest.fn();
const mockGetById = jest.fn();
const mockStats = jest.fn();
const mockClose = jest.fn();

jest.mock('../../shared/storage/auditStore', () => {
  return {
    AuditStore: jest.fn().mockImplementation(() => ({
      insert: mockInsert,
      query: mockQuery,
      getById: mockGetById,
      stats: mockStats,
      close: mockClose,
      ready: true,
      pool: { query: jest.fn() }
    }))
  };
});

// Mock safeFetch for PDF proxy
jest.mock('../../shared/utils/helpers', () => {
  const original = jest.requireActual('../../shared/utils/helpers');
  return {
    ...original,
    safeFetch: jest.fn(),
  };
});

const { safeFetch, hmacSha256Hex, sha256Hex } = require('../../shared/utils/helpers');
const { buildSigningString } = require('../../shared/middleware/auth');
const { app, store } = require('./index');

// Stop sweeper interval that was started in index.js
afterAll(() => {
  // It's a bit hacky, but any pending setTimeouts from index.js 
  // shouldn't keep the test open because they're .unref()'d.
});

describe('Audit Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Health Endpoints', () => {
    it('returns 200 for /health/live', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 200 for /health/ready when store is ready', async () => {
      mockStats.mockResolvedValueOnce({ count: 10 });
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
    });
  });

  describe('POST /api/v1/audit/events', () => {
    it('rejects without HMAC', async () => {
      const res = await request(app).post('/api/v1/audit/events').send({});
      expect(res.status).toBe(401);
    });

    it('rejects missing recommendation_id or customer_id', async () => {
      const ts = Date.now().toString();
      const body = {}; // Missing fields
      const bodyHash = sha256Hex(JSON.stringify(body));
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'POST', '/api/v1/audit/events', bodyHash));

      const res = await request(app)
        .post('/api/v1/audit/events')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('ingests a valid event', async () => {
      const ts = Date.now().toString();
      const body = { recommendation_id: 'rec123', customer_id: 'cust123' };
      const bodyHash = sha256Hex(JSON.stringify(body));
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'POST', '/api/v1/audit/events', bodyHash));

      mockInsert.mockResolvedValueOnce();

      const res = await request(app)
        .post('/api/v1/audit/events')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .send(body);

      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(mockInsert).toHaveBeenCalledWith(body);
    });

    it('returns 409 for duplicate recommendation_id', async () => {
      const ts = Date.now().toString();
      const body = { recommendation_id: 'rec123', customer_id: 'cust123' };
      const bodyHash = sha256Hex(JSON.stringify(body));
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'POST', '/api/v1/audit/events', bodyHash));

      mockInsert.mockRejectedValueOnce(new Error('ER_DUP_ENTRY: Duplicate entry'));

      const res = await request(app)
        .post('/api/v1/audit/events')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .send(body);

      expect(res.status).toBe(409);
      expect(res.body.error_code).toBe('DUPLICATE_RECOMMENDATION_ID');
    });
  });

  describe('GET /api/v1/audit/logs', () => {
    it('queries logs with filter constraints for RM', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/audit/logs', bodyHash));

      mockQuery.mockResolvedValueOnce({ logs: [], total: 0 });

      const res = await request(app)
        .get('/api/v1/audit/logs')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-Employee-Id', 'RM_EMP')
        .set('X-User-Role', 'RM');

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({ employee_id: 'RM_EMP' }));
    });
  });

  describe('GET /api/v1/audit/recommendations/:id', () => {
    it('fetches a recommendation if authorized', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/audit/recommendations/rec1', bodyHash));

      mockGetById.mockResolvedValueOnce({ recommendation_id: 'rec1', employee_id: 'RM_EMP' });

      const res = await request(app)
        .get('/api/v1/audit/recommendations/rec1')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-Employee-Id', 'RM_EMP')
        .set('X-User-Role', 'RM');

      expect(res.status).toBe(200);
      expect(res.body.recommendation_id).toBe('rec1');
    });

    it('blocks access to other RM\'s recommendation', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/audit/recommendations/rec1', bodyHash));

      mockGetById.mockResolvedValueOnce({ recommendation_id: 'rec1', employee_id: 'OTHER_RM' });

      const res = await request(app)
        .get('/api/v1/audit/recommendations/rec1')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-Employee-Id', 'RM_EMP')
        .set('X-User-Role', 'RM');

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/audit/recommendations/:id/pdf', () => {
    it('proxies PDF generation from yield-engine', async () => {
      const ts = Date.now().toString();
      const bodyHash = sha256Hex('');
      const sig = hmacSha256Hex(process.env.HMAC_SHARED_SECRET, buildSigningString(ts, 'GET', '/api/v1/audit/recommendations/rec1/pdf', bodyHash));

      mockGetById.mockResolvedValueOnce({ recommendation_id: 'rec1', employee_id: 'RM_EMP' });
      safeFetch.mockResolvedValueOnce({
        status: 200,
        headers: new Map([['content-type', 'application/pdf']]),
        arrayBuffer: async () => Buffer.from('PDF_BYTES'),
      });

      const res = await request(app)
        .get('/api/v1/audit/recommendations/rec1/pdf')
        .set('X-Gateway-Timestamp', ts)
        .set('X-Internal-Signature', sig)
        .set('X-Employee-Id', 'RM_EMP')
        .set('X-User-Role', 'RM');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/reports/rec1'),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });
});
