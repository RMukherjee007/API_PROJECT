const { rateLimiter } = require('./rateLimiter');
const config = require('../config');

// We will mock the config
jest.mock('../config', () => ({
  security: {
    rateLimitWindowMs: 1000,
    rateLimitMax: 2,
  },
  redis: {
    enabled: false, // We'll test the memory fallback first
    url: 'redis://localhost:6379',
  },
  logging: { file: false, pretty: false },
  log: { level: 'error' },
  serviceName: 'test-service'
}));

describe('shared/middleware/rateLimiter', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      ip: '127.0.0.1',
      headers: {},
      traceparent: 'trace-123',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    next = jest.fn();
    
    // Clear the memory map (hacky, but works since it's module-level state)
    // Actually, we can just use different IPs for different tests to avoid state bleed.
  });

  describe('in-memory fallback (redis disabled/unavailable)', () => {
    it('allows requests under the limit', async () => {
      req.ip = '10.0.0.1';
      
      await rateLimiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      await rateLimiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);
    });

    it('blocks requests over the limit', async () => {
      req.ip = '10.0.0.2';
      
      await rateLimiter(req, res, next);
      await rateLimiter(req, res, next);
      
      // Third request should be blocked (limit is 2)
      await rateLimiter(req, res, next);
      
      expect(next).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'RATE_LIMIT_EXCEEDED' }));
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    });

    it('uses x-forwarded-for if ip is missing', async () => {
      req.ip = undefined;
      req.headers['x-forwarded-for'] = '10.0.0.3';
      
      await rateLimiter(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
