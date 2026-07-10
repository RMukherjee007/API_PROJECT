const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-32-bytes-long';
process.env.JWT_ISSUER = 'test-issuer';
process.env.JWT_AUDIENCE = 'test-audience';
process.env.REDIS_ENABLED = 'false'; // for rateLimiter

// Mock MySQL
const mockQuery = jest.fn();
const mockGetConnection = jest.fn();
const mockRelease = jest.fn();
const mockBeginTransaction = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();

jest.mock('mysql2/promise', () => {
  return {
    createPool: jest.fn(() => ({
      query: mockQuery,
      getConnection: mockGetConnection,
      end: jest.fn(),
    })),
  };
});

const app = require('./index');

describe('Auth Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock behavior for MySQL connection
    mockGetConnection.mockResolvedValue({
      query: mockQuery,
      beginTransaction: mockBeginTransaction,
      commit: mockCommit,
      rollback: mockRollback,
      release: mockRelease,
    });
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
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns tokens in HttpOnly cookies and success in body', async () => {
      mockQuery.mockResolvedValueOnce([{}]); // insertRefreshToken

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'test', password: 'pwd' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.user.employee_id).toBe('EMP-PLACEHOLDER');

      // Check cookies
      const cookies = res.headers['set-cookie'];
      expect(cookies).toHaveLength(2);
      expect(cookies.some(c => c.startsWith('access_token=') && c.includes('HttpOnly'))).toBe(true);
      expect(cookies.some(c => c.startsWith('refresh_token=') && c.includes('HttpOnly') && c.includes('Path=/api/v1/auth/refresh'))).toBe(true);
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('rejects missing refresh token', async () => {
      const res = await request(app).post('/api/v1/auth/refresh');
      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('rejects invalid refresh token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', ['refresh_token=invalid-token']);
      expect(res.status).toBe(401);
      expect(res.body.error_code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('rotates tokens successfully', async () => {
      // Create a valid refresh token
      const token = jwt.sign(
        { sub: 'EMP-PLACEHOLDER', jti: 'test-jti', type: 'refresh' },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE }
      );

      // isRefreshTokenRevoked -> returns valid
      mockQuery.mockResolvedValueOnce([[{ revoked: 0, expires_at: Date.now() + 100000 }]]);
      
      // The transaction will do an UPDATE and an INSERT.
      mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE
      mockQuery.mockResolvedValueOnce([{ insertId: 1 }]); // INSERT

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', [`refresh_token=${token}`]);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      
      const cookies = res.headers['set-cookie'];
      expect(cookies).toHaveLength(2);
      
      // Ensure the transaction was committed
      expect(mockBeginTransaction).toHaveBeenCalled();
      expect(mockCommit).toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/auth/introspect', () => {
    it('returns active: true for valid token', async () => {
      const token = jwt.sign(
        { sub: 'EMP-PLACEHOLDER', role: 'RM' },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE }
      );

      const res = await request(app)
        .post('/api/v1/auth/introspect')
        .send({ token });

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
      expect(res.body.claims.sub).toBe('EMP-PLACEHOLDER');
    });

    it('returns active: false for invalid token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/introspect')
        .send({ token: 'invalid-token' });

      expect(res.status).toBe(200); // Introspect always returns 200, but with active: false
      expect(res.body.active).toBe(false);
    });
  });
  
  describe('GET /api/v1/auth/me', () => {
    it('returns user info when authenticated', async () => {
      const token = jwt.sign(
        { sub: 'EMP-PLACEHOLDER', role: 'RM' },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE }
      );

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Cookie', [`access_token=${token}`]);

      expect(res.status).toBe(200);
      expect(res.body.employee_id).toBe('EMP-PLACEHOLDER');
    });

    it('rejects when not authenticated', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('clears cookies and revokes token', async () => {
      const token = jwt.sign(
        { sub: 'EMP-PLACEHOLDER', jti: 'test-jti', type: 'refresh' },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE }
      );

      mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', [`refresh_token=${token}`]);

      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE refresh_tokens SET revoked = 1'), ['test-jti']);
      
      const cookies = res.headers['set-cookie'];
      expect(cookies.some(c => c.startsWith('access_token=') && c.includes('Max-Age=0') || c.includes('Expires='))).toBe(true);
    });
  });
});
