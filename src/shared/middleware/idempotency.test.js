const { idempotencyCheck } = require('./idempotency');

jest.mock('../config', () => ({
  redis: { idempotencyTtlSeconds: 10 },
  logging: { file: false, pretty: false },
  log: { level: 'error' },
  serviceName: 'test-service'
}));

jest.mock('./rateLimiter', () => ({
  redis: null, // Force memory fallback
}));

describe('shared/middleware/idempotency', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      method: 'POST',
      path: '/optimize',
      headers: {},
      body: { some: 'data' },
      traceparent: 'trace-123',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    next = jest.fn();
  });

  it('skips non-POST requests', () => {
    req.method = 'GET';
    idempotencyCheck(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('skips non-/optimize paths', () => {
    req.path = '/other';
    idempotencyCheck(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects missing idempotency key', () => {
    idempotencyCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'MISSING_REQUIRED_FIELD' }));
  });

  it('rejects invalid idempotency key format', () => {
    req.headers['idempotency-key'] = 'short';
    idempotencyCheck(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'INVALID_FORMAT' }));
  });

  it('allows new request and sets up hooks', (done) => {
    req.headers['idempotency-key'] = 'valid-key-1234567890';
    
    next.mockImplementation(() => {
      expect(req.storeIdempotentResponse).toBeDefined();
      expect(req.clearIdempotent).toBeDefined();
      done();
    });

    idempotencyCheck(req, res, next);
  });

  it('blocks concurrent request while pending', (done) => {
    const key = 'concurrent-key-1234567890';
    
    // First request
    const req1 = { ...req, headers: { 'idempotency-key': key } };
    const res1 = { ...res };
    const next1 = jest.fn(() => {
      // While req1 is pending, send req2
      const req2 = { ...req, headers: { 'idempotency-key': key } };
      const res2 = {
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        json: jest.fn().mockImplementation((payload) => {
          expect(res2.status).toHaveBeenCalledWith(409);
          expect(payload.error_code).toBe('IDEMPOTENCY_CONFLICT');
          done();
        }),
      };
      idempotencyCheck(req2, res2, jest.fn());
    });
    
    idempotencyCheck(req1, res1, next1);
  });

  it('rejects reused key with different body', (done) => {
    const key = 'diff-body-key-1234567890';
    
    const req1 = { ...req, headers: { 'idempotency-key': key } };
    
    idempotencyCheck(req1, res, () => {
      // req1 is now pending
      const req2 = { ...req, headers: { 'idempotency-key': key }, body: { diff: 'data' } };
      const res2 = {
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        json: jest.fn().mockImplementation((payload) => {
          expect(res2.status).toHaveBeenCalledWith(409);
          expect(payload.error_code).toBe('IDEMPOTENCY_CONFLICT');
          done();
        }),
      };
      idempotencyCheck(req2, res2, jest.fn());
    });
  });

  it('returns cached response for resolved request', (done) => {
    const key = 'resolved-key-1234567890';
    const req1 = { ...req, headers: { 'idempotency-key': key } };
    
    idempotencyCheck(req1, res, async () => {
      // Simulate completing the request
      await req1.storeIdempotentResponse({ optimized: true });
      
      // Re-send request
      const req2 = { ...req, headers: { 'idempotency-key': key } };
      const res2 = {
        status: jest.fn().mockReturnThis(),
        type: jest.fn().mockReturnThis(),
        json: jest.fn().mockImplementation((payload) => {
          expect(res2.status).toHaveBeenCalledWith(200);
          expect(payload).toEqual({ optimized: true });
          done();
        }),
        setHeader: jest.fn(),
      };
      
      idempotencyCheck(req2, res2, jest.fn());
    });
  });
});
