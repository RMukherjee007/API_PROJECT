/**
 * Idempotency middleware.
 *
 * Uses Redis with SETNX + TTL for safe concurrent retry detection.
 * Falls back to in-memory Map if Redis is unavailable.
 *
 * Behavior:
 *   - First POST with key K: store as `pending`, allow through.
 *   - Same K + same body hash while pending: 409 IDEMPOTENCY_CONFLICT.
 *   - Same K + different body hash: 409 IDEMPOTENCY_CONFLICT.
 *   - Same K + same body hash after resolved: replay stored response.
 *   - On error from handler, clear pending entry so retry can succeed.
 */

const crypto = require('crypto');
const config = require('../config');
const { sendProblemJson } = require('../utils/helpers');
const { redis } = require('./rateLimiter');

const memoryFallback = new Map();

function hashBody(req) {
  const bodyString = req.rawBody !== undefined
    ? (req.rawBody.length === 0 ? '' : req.rawBody.toString('utf8'))
    : (req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '');
  return crypto.createHash('sha256').update(bodyString).digest('hex');
}

async function getStored(key) {
  if (redis) {
    try {
      const raw = await redis.get(`idem:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return memoryFallback.get(key) || null; }
  }
  return memoryFallback.get(key) || null;
}

async function setStored(key, value, ttlSeconds) {
  if (redis) {
    try {
      await redis.set(`idem:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
      return;
    } catch { /* fall through to memory */ }
  }
  memoryFallback.set(key, { ...value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function claimStored(key, value, ttlSeconds) {
  if (redis) {
    try {
      const result = await redis.set(`idem:${key}`, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch { /* fall through to memory */ }
  }
  const existing = memoryFallback.get(key);
  if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) return false;
  memoryFallback.set(key, { ...value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return true;
}

async function deleteStored(key) {
  if (redis) {
    try { await redis.del(`idem:${key}`); return; } catch { /* fall through */ }
  }
  memoryFallback.delete(key);
}

function idempotencyCheck(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/optimize') return next();

  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey) {
    return sendProblemJson(res, 400, 'MISSING_REQUIRED_FIELD', 'Missing Idempotency-Key header.', req.traceparent, {
      'Idempotency-Key': 'is required',
    });
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return sendProblemJson(res, 400, 'INVALID_FORMAT', 'Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen.', req.traceparent, {
      'Idempotency-Key': 'invalid format',
    });
  }

  const bodyHash = hashBody(req);
  const ttlSeconds = config.redis.idempotencyTtlSeconds;

  (async () => {
    const cached = await getStored(idempotencyKey);
    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        return sendProblemJson(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with different request body.', req.traceparent);
      }
      if (cached.status === 'pending') {
        return sendProblemJson(res, 409, 'IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is already in progress.', req.traceparent);
      }
      res.setHeader('X-Idempotency-Replay', 'true');
      return res.status(200).json(cached.response);
    }

    const claimed = await claimStored(idempotencyKey, { status: 'pending', bodyHash, createdAt: Date.now() }, ttlSeconds);
    if (!claimed) {
      const fresh = await getStored(idempotencyKey);
      if (fresh?.bodyHash !== bodyHash) {
        return sendProblemJson(res, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with different request body.', req.traceparent);
      }
      return sendProblemJson(res, 409, 'IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is already in progress.', req.traceparent);
    }
    req.idempKey = idempotencyKey;
    req.idempHash = bodyHash;
    req.storeIdempotentResponse = async (response) => {
      await setStored(idempotencyKey, { status: 'resolved', bodyHash, response, createdAt: Date.now() }, ttlSeconds);
    };
    req.clearIdempotent = async () => {
      await deleteStored(idempotencyKey);
    };
    next();
  })().catch(next);
}

// In-memory cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memoryFallback.entries()) if (v.expiresAt && now > v.expiresAt) memoryFallback.delete(k);
}, 3600_000).unref();

module.exports = { idempotencyCheck };
