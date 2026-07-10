const {
  generateTraceparent,
  extractCorrelationId,
  correlationMiddleware,
  sendProblemJson,
  sha256Hex,
  hmacSha256Hex,
  buildSignedRequestHeaders,
  formatCurrency,
  formatPct,
  CircuitBreaker,
  safeFetch,
} = require('./helpers');

describe('shared/utils/helpers', () => {
  describe('generateTraceparent', () => {
    it('generates a valid W3C traceparent', () => {
      const tp = generateTraceparent();
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it('uses provided spanId', () => {
      const tp = generateTraceparent('1234567890abcdef');
      expect(tp).toMatch(/^00-[0-9a-f]{32}-1234567890abcdef-01$/);
    });
  });

  describe('extractCorrelationId', () => {
    it('extracts from traceparent', () => {
      const cid = extractCorrelationId({ headers: { traceparent: '00-00000000000000000000000000000001-0000000000000002-01' } });
      expect(cid).toBe('00000000000000000000000000000001');
    });

    it('extracts from x-correlation-id', () => {
      const cid = extractCorrelationId({ headers: { 'x-correlation-id': 'custom-cid' } });
      expect(cid).toBe('custom-cid');
    });

    it('generates new if none provided', () => {
      const cid = extractCorrelationId({ headers: {} });
      expect(cid).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('correlationMiddleware', () => {
    it('sets req.correlationId and req.traceparent', () => {
      const req = { headers: {} };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();

      correlationMiddleware(req, res, next);
      
      expect(req.correlationId).toBeDefined();
      expect(req.traceparent).toBeDefined();
      expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', req.correlationId);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('sendProblemJson', () => {
    it('formats a problem json response', () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      
      sendProblemJson(res, 400, 'BAD_REQUEST', 'Invalid param', 'trace-123', { field: 'invalid' });
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.type).toHaveBeenCalledWith('application/problem+json');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        type: 'https://api.bank.com/errors/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid param',
        instance: 'trace-123',
        error_code: 'BAD_REQUEST',
        invalid_fields: { field: 'invalid' },
      }));
    });
  });

  describe('formatting', () => {
    it('formats currency', () => {
      expect(formatCurrency(1234.567)).toBe('1234.57');
      expect(formatCurrency(null)).toBe('0.00');
      expect(formatCurrency('abc')).toBe('0.00');
    });

    it('formats pct', () => {
      expect(formatPct(0.12345)).toBe('0.1235');
      expect(formatPct(null)).toBe('0.0000');
    });
  });

  describe('crypto', () => {
    it('computes sha256', () => {
      expect(sha256Hex('test')).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
      expect(sha256Hex({ a: 1 })).toBe(sha256Hex('{"a":1}'));
    });

    it('computes hmac sha256', () => {
      expect(hmacSha256Hex('secret', 'message')).toBe('8b5f48702995c1598c573db1e21866a9b825d4a794d169d7060a03605796360b');
    });

    it('builds signed request headers', () => {
      const headers = buildSignedRequestHeaders({
        secret: 'secret',
        method: 'POST',
        path: '/api',
        body: 'body',
        timestamp: '123',
        employeeId: 'EMP1',
        userRole: 'ADMIN',
        extraHeaders: { 'X-Custom': '1' }
      });

      expect(headers['X-Gateway-Timestamp']).toBe('123');
      expect(headers['X-Internal-Signature']).toBeDefined();
      expect(headers['X-Employee-ID']).toBe('EMP1');
      expect(headers['X-User-Role']).toBe('ADMIN');
      expect(headers['X-Custom']).toBe('1');
    });
  });

  describe('CircuitBreaker', () => {
    it('opens after threshold failures and allows half-open', () => {
      const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100 });
      expect(cb.canPass()).toBe(true);
      
      cb.recordFailure();
      expect(cb.canPass()).toBe(true);
      
      cb.recordFailure();
      expect(cb.canPass()).toBe(false); // Opened
      
      const originalNow = Date.now;
      Date.now = jest.fn(() => originalNow() + 200);
      
      expect(cb.canPass()).toBe(true); // Half open
      expect(cb.state).toBe('HALF_OPEN');
      
      cb.recordSuccess();
      expect(cb.state).toBe('CLOSED');
      
      Date.now = originalNow;
    });
  });

  describe('safeFetch', () => {
    let originalFetch;
    
    beforeEach(() => {
      originalFetch = global.fetch;
    });
    
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns successfully on 200', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const res = await safeFetch('http://test.com', {}, { timeoutMs: 100 });
      expect(res.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 4xx', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 });
      const res = await safeFetch('http://test.com', {}, { timeoutMs: 100, retries: 2 });
      expect(res.status).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries on 5xx', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
        
      const res = await safeFetch('http://test.com', {}, { timeoutMs: 100, retries: 2, backoffMs: 1 });
      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries on network error and throws if out of retries', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
        
      await expect(safeFetch('http://test.com', {}, { timeoutMs: 100, retries: 2, backoffMs: 1 }))
        .rejects.toThrow('Network error');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });
});
