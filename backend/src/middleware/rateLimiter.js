/**
 * src/middleware/rateLimiter.js
 *
 * Rate limiting middleware for Stellar IndigoPay.
 *
 * Exports:
 *   - createRateLimiter(maxRequests, windowMinutes)
 *       Legacy factory backed by express-rate-limit (in-memory). Used by
 *       route-specific limiters in donations.js & verification.js.
 *
 *   - redisRateLimiter(req, res, next)
 *       New per-endpoint Redis-backed sliding window middleware.
 *       Falls back to in-memory (no-op pass-through) when Redis is
 *       unavailable so the API stays up during a cache outage.
 *
 *   - slidingWindowRateLimit(key, limit, windowMs)
 *       Core Redis sorted-set algorithm. Exported for direct use / testing.
 */

"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");

// Re-export the legacy factory unchanged so existing route-level limiters
// continue to work without modification.
const createRateLimiter = (maxRequests, windowMinutes) => {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      (req.log || logger).warn(
        {
          event: "rate_limit_hit",
          ip: req.ip,
          path: req.path,
          method: req.method,
          limit: maxRequests,
          windowMinutes,
        },
        "Rate limit exceeded",
      );
      res.set("Retry-After", Math.ceil(windowMinutes * 60));
      return res.status(429).json({
        message: "Too many requests — Try again later.",
      });
    },
  });
};

// ── Redis sliding window helpers ────────────────────────────────────────────

const redisService = require("../services/redis");
const { getRateLimitConfig } = require("./rateLimitConfig");

// Prometheus gauge: remaining capacity per endpoint. Registered on the
// shared registry so the /metrics endpoint emits it automatically.
const client = require("prom-client");
const { registry } = require("../services/metrics");

const rateLimitRemaining = new client.Gauge({
  name: "indigopay_rate_limit_remaining",
  help: "Rate limit remaining capacity per endpoint (sliding window).",
  labelNames: ["endpoint"],
  registers: [registry],
});

const rateLimitHitsTotal = new client.Counter({
  name: "indigopay_rate_limit_hits_total",
  help: "Total number of rate-limited (429) responses per endpoint.",
  labelNames: ["method", "endpoint"],
  registers: [registry],
});

/**
 * Sliding-window rate-limit check using a Redis sorted set.
 *
 * Algorithm:
 *   1. Add current timestamp as a member of the sorted set.
 *   2. Remove entries older than `windowMs`.
 *   3. Count remaining (non-expired) entries.
 *   4. Set key TTL for automatic cleanup.
 *
 * @param {string}  key      Redis key (e.g. "ratelimit:1.2.3.4:POST:/api/donations")
 * @param {number}  limit    Max number of requests allowed in the window
 * @param {number}  windowMs Window duration in milliseconds
 * @returns {Promise<{ allowed: boolean, remaining: number, reset: number, limit: number }>}
 */
async function slidingWindowRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const member = `${now}-${Math.random()}`;
  const client = redisService.getClient();

  // ── Pipeline: batch all Redis commands into one round-trip ────────────
  const pipeline = client.pipeline();
  pipeline.zadd(key, now, member);
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.expire(key, Math.ceil(windowMs / 1000));
  const results = await pipeline.exec();

  // pipeline.exec() returns [[err, result], …]. We ignore errors for the
  // add/remove steps and only read the count from the zcard result (index 2).
  const count = results[2] && results[2][1] !== undefined ? results[2][1] : 0;
  const remaining = Math.max(0, limit - count);
  // Reset timestamp (seconds since epoch) when the oldest entry expires.
  const reset = Math.ceil((now + windowMs - (now - windowStart)) / 1000);

  return { allowed: count <= limit, remaining, reset, limit };
}

/**
 * Per-endpoint Redis-backed sliding window rate limiter.
 *
 * Reads the rate limit config from rateLimitConfig.js based on the request's
 * method and path, performs a sliding window check via Redis, sets standard
 * rate-limit response headers, and rejects with HTTP 429 when the limit is
 * exceeded.
 *
 * When Redis is unreachable the middleware degrades gracefully to a no-op
 * (all requests pass through) so the API stays available during a cache
 * outage. In degraded mode a warning is emitted once per fallback event.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function redisRateLimiter(req, res, next) {
  const config = getRateLimitConfig(req.method, req.path);
  const key = `ratelimit:${req.ip}:${req.method}:${req.path}`;

  try {
    const result = await slidingWindowRateLimit(
      key,
      config.points,
      config.duration * 1000,
    );

    // ── Set standard rate-limit response headers ────────────────────────
    res.setHeader("X-RateLimit-Limit", String(config.points));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(result.reset));

    // ── Update Prometheus gauge for remaining capacity ──────────────────
    rateLimitRemaining.set({ endpoint: req.path }, result.remaining);

    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.reset));
      rateLimitHitsTotal.inc({ method: req.method, endpoint: req.path });

      (req.log || logger).warn(
        {
          event: "rate_limit_hit",
          ip: req.ip,
          path: req.path,
          method: req.method,
          limit: config.points,
          windowSeconds: config.duration,
          remaining: result.remaining,
        },
        "Rate limit exceeded (Redis sliding window)",
      );

      return res.status(429).json({
        error: "Too many requests — Try again later.",
        retryAfter: result.reset,
      });
    }

    next();
  } catch (err) {
    // Redis unavailable — fall back to in-memory pass-through so the API
    // stays up during a cache outage or deployment transition.
    logger.warn(
      {
        event: "rate_limit_redis_fallback",
        err: err.message,
        ip: req.ip,
        path: req.path,
        method: req.method,
      },
      "Redis unavailable for rate limiting — skipping check",
    );

    // In degraded mode we still set the header so clients see the
    // configured limit even though we can't enforce it.
    res.setHeader("X-RateLimit-Limit", String(config.points));
    res.setHeader("X-RateLimit-Remaining", String(config.points));

    next();
  }
}

module.exports = {
  createRateLimiter,
  redisRateLimiter,
  slidingWindowRateLimit,
};
