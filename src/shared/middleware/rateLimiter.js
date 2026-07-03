/**
 * Redis-backed sliding-window rate limiter.
 *
 * Uses INCR + EXPIRE so each IP gets at most `max` requests per `windowMs`.
 * Falls back to in-memory Map if Redis is unavailable (dev only).
 */

const Redis = require('ioredis');
const config = require('../config');
const { logger } = require('../logger');

let redis = null;
if (config.redis.enabled) {
  try {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 2,
      retryStrategy: (t) => Math.min(t * 100, 2000),
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: false,
    });
    redis.on('error', (err) => logger.warn('redis_rate_limit_error', { error: err.message }));
    redis.on('ready', () => logger.info('redis_rate_limit_ready'));
  } catch (err) {
    logger.warn('redis_init_failed', { error: err.message });
    redis = null;
  }
}

const memory = new Map(); // dev fallback

function memoryKey(req) {
  return req.ip || req.headers?.['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
}

async function rateLimiter(req, res, next) {
  const key = `rl:${memoryKey(req)}`;
  const windowSec = Math.ceil(config.security.rateLimitWindowMs / 1000);
  const max = config.security.rateLimitMax;

  try {
    if (redis) {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      if (count > max) {
        res.setHeader('Retry-After', windowSec);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', '0');
        return res.status(429).type('application/problem+json').json({
          type: 'https://api.bank.com/errors/rate-limit-exceeded',
          title: 'Too Many Requests',
          status: 429,
          detail: `Rate limit exceeded. Max ${max} requests per ${windowSec}s.`,
          error_code: 'RATE_LIMIT_EXCEEDED',
          instance: req.traceparent,
          timestamp: new Date().toISOString(),
        });
      }
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      return next();
    }
  } catch (err) {
    logger.warn('rate_limit_redis_fail_fallback_memory', { error: err.message });
  }

  // In-memory fallback
  const k = memoryKey(req);
  const now = Date.now();
  const entry = memory.get(k);
  if (!entry || now > entry.resetAt) {
    memory.set(k, { count: 1, resetAt: now + windowSec * 1000 });
    return next();
  }
  entry.count += 1;
  if (entry.count > max) {
    res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
    return res.status(429).type('application/problem+json').json({
      type: 'https://api.bank.com/errors/rate-limit-exceeded',
      title: 'Too Many Requests',
      status: 429,
      detail: `Rate limit exceeded. Max ${max} requests per ${windowSec}s.`,
      error_code: 'RATE_LIMIT_EXCEEDED',
      instance: req.traceparent,
      timestamp: new Date().toISOString(),
    });
  }
  next();
}

// periodic cleanup for in-memory map
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory.entries()) if (now > v.resetAt) memory.delete(k);
}, 60_000).unref();

module.exports = { rateLimiter, redis };