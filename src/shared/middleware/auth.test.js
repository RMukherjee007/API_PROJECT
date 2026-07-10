const jwt = require('jsonwebtoken');
const {
  authenticateRequest,
  authenticateJwt,
  requireOverrideRole,
  requireRole,
  buildSigningString,
} = require('./auth');
const config = require('../config');
const { hmacSha256Hex, sha256Hex } = require('../utils/helpers');

jest.mock('../config', () => ({
  security: {
    hmacSecret: 'test-secret',
    jwtSecret: 'jwt-secret',
    jwtIssuer: 'test-issuer',
    jwtAudience: 'test-audience',
    timestampSkewSeconds: 30,
  },
  logging: { file: false, pretty: false },
  log: { level: 'error' },
  serviceName: 'test-service'
}));

describe('shared/middleware/auth', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      headers: {},
      query: {},
      body: {},
      method: 'POST',
      originalUrl: '/api/test',
      traceparent: 'trace-123',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  describe('authenticateRequest', () => {
    it('authenticates a valid signed request', () => {
      const ts = Date.now().toString();
      req.headers['x-gateway-timestamp'] = ts;
      req.headers['x-user-role'] = 'ADMIN';
      req.headers['x-employee-id'] = 'EMP1';
      
      const bodyHash = sha256Hex('');
      const signingStr = buildSigningString(ts, 'POST', '/api/test', bodyHash);
      req.headers['x-internal-signature'] = hmacSha256Hex(config.security.hmacSecret, signingStr);

      authenticateRequest(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.userRole).toBe('ADMIN');
      expect(req.employeeId).toBe('EMP1');
      expect(req.signatureValid).toBe(true);
    });

    it('rejects missing timestamp', () => {
      authenticateRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'TIMESTAMP_SKEW' }));
    });

    it('rejects skewed timestamp', () => {
      const ts = (Date.now() - 40000).toString(); // 40 seconds ago
      req.headers['x-gateway-timestamp'] = ts;
      authenticateRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'TIMESTAMP_SKEW' }));
    });

    it('rejects missing signature', () => {
      req.headers['x-gateway-timestamp'] = Date.now().toString();
      authenticateRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'MISSING_SIGNATURE' }));
    });

    it('rejects invalid signature', () => {
      req.headers['x-gateway-timestamp'] = Date.now().toString();
      req.headers['x-internal-signature'] = 'invalid-hex-string-that-is-not-64-chars';
      authenticateRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'SIGNATURE_MISMATCH' }));
    });

    it('rejects signature mismatch', () => {
      req.headers['x-gateway-timestamp'] = Date.now().toString();
      req.headers['x-internal-signature'] = 'a'.repeat(64); // Valid format, wrong sig
      authenticateRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'SIGNATURE_MISMATCH' }));
    });

    it('rejects unauthorized roles', () => {
      const ts = Date.now().toString();
      req.headers['x-gateway-timestamp'] = ts;
      req.headers['x-user-role'] = 'HACKER';
      
      const bodyHash = sha256Hex('');
      const signingStr = buildSigningString(ts, 'POST', '/api/test', bodyHash);
      req.headers['x-internal-signature'] = hmacSha256Hex(config.security.hmacSecret, signingStr);

      authenticateRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'INSUFFICIENT_ROLE' }));
    });
  });

  describe('authenticateJwt', () => {
    it('authenticates valid Bearer token', () => {
      const token = jwt.sign({ sub: 'EMP1', role: 'RM' }, config.security.jwtSecret, {
        audience: config.security.jwtAudience,
        issuer: config.security.jwtIssuer,
      });
      req.headers.authorization = `Bearer ${token}`;

      authenticateJwt(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.employeeId).toBe('EMP1');
      expect(req.userRole).toBe('RM');
    });

    it('authenticates valid token in query param', () => {
      const token = jwt.sign({ sub: 'EMP1', role: 'ADMIN' }, config.security.jwtSecret, {
        audience: config.security.jwtAudience,
        issuer: config.security.jwtIssuer,
      });
      req.query.token = token;

      authenticateJwt(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects missing token', () => {
      authenticateJwt(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'UNAUTHENTICATED' }));
    });

    it('rejects invalid token', () => {
      req.headers.authorization = 'Bearer invalid.token.string';
      authenticateJwt(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'UNAUTHENTICATED' }));
    });

    it('rejects unauthorized role in token', () => {
      const token = jwt.sign({ sub: 'EMP1', role: 'INVALID_ROLE' }, config.security.jwtSecret, {
        audience: config.security.jwtAudience,
        issuer: config.security.jwtIssuer,
      });
      req.headers.authorization = `Bearer ${token}`;

      authenticateJwt(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'INSUFFICIENT_ROLE' }));
    });
  });

  describe('requireOverrideRole', () => {
    it('allows RM if no override requested', () => {
      req.userRole = 'RM';
      req.body = { customer_id: '123' };
      requireOverrideRole(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects RM if override requested', () => {
      req.userRole = 'RM';
      req.body = { fx_rate_overrides: {} };
      requireOverrideRole(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('allows ADMIN if override requested', () => {
      req.userRole = 'ADMIN';
      req.body = { fx_rate_overrides: {} };
      requireOverrideRole(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
  
  describe('requireRole', () => {
    it('allows specified roles', () => {
      req.userRole = 'AUDITOR';
      requireRole('ADMIN', 'AUDITOR')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects unlisted roles', () => {
      req.userRole = 'RM';
      requireRole('ADMIN', 'AUDITOR')(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
