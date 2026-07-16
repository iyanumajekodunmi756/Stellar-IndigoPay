/**
 * __tests__/middleware/rateLimiter.test.js
 *
 * Unit tests for the Redis-backed sliding window rate limiter.
 *
 * Coverage:
 *   - slidingWindowRateLimit: allows under limit, blocks over limit
 *   - redisRateLimiter: headers set correctly, 429 on over-limit
 *   - Redis failure fallback (no-op pass-through)
 *   - rateLimitConfig: pattern matching, wildcards, defaults
 *   - Legacy createRateLimiter (backward compat integration)
 */

"use strict";

// ── Mocks ───────────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock factories must NOT reference out-of-scope variables
// (Jest hoists them). All mock setup happens inline inside the factory.

jest.mock("prom-client", () => {
  const mockSet = jest.fn();
  const mockInc = jest.fn();
  return {
    Gauge: jest.fn(() => ({ set: mockSet })),
    Counter: jest.fn(() => ({ inc: mockInc })),
    Histogram: jest.fn(() => ({ observe: jest.fn() })),
    Registry: jest.fn().mockImplementation(() => ({
      registerMetric: jest.fn(),
      metrics: jest.fn().mockResolvedValue(""),
      contentType: "text/plain",
      setDefaultLabels: jest.fn(),
    })),
    collectDefaultMetrics: jest.fn(),
  };
});

jest.mock("../../src/services/redis", () => ({
  getClient: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  deletePattern: jest.fn(),
}));

jest.mock("../../src/services/metrics", () => ({
  registry: {
    registerMetric: jest.fn(),
    metrics: jest.fn().mockResolvedValue(""),
    contentType: "text/plain",
    setDefaultLabels: jest.fn(),
  },
  normaliseRoute: jest.fn(),
  refreshDbPoolMetrics: jest.fn(),
  refreshQueueMetrics: jest.fn(),
  metrics: {},
}));

jest.mock("express-rate-limit", () => {
  const mockMiddleware = jest.fn((options) => {
    const fn = (req, res, next) => {
      if (!fn._counter) fn._counter = { count: 0 };
      fn._counter.count += 1;
      if (fn._counter.count > options.max) {
        res.set("Retry-After", Math.ceil((options.windowMs || 60000) / 1000));
        return options.handler
          ? options.handler(req, res)
          : res.status(429).json({ message: "Too many requests" });
      }
      res.set("X-RateLimit-Limit", options.max);
      next();
    };
    fn._options = options;
    return fn;
  });
  return mockMiddleware;
});

// ── Module imports (after mocks are set up) ────────────────────────────────
const express = require("express");
const request = require("supertest");
const redisService = require("../../src/services/redis");

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock pipeline with controllable `exec` behaviour.
 * Each call to `mockPipelineExec` returns the next resolved value.
 */
function createMockPipeline() {
  const mockPipelineExec = jest.fn();
  const mockPipelineObj = {
    zadd: jest.fn().mockReturnThis(),
    zremrangebyscore: jest.fn().mockReturnThis(),
    zcard: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: mockPipelineExec,
  };
  return mockPipelineObj;
}

/** Set a single resolved value for pipeline.exec(). */
function mockPipelineExec(mockPipelineObj, resolvedValue) {
  mockPipelineObj.exec.mockResolvedValueOnce(resolvedValue);
}

/** Set pipeline.exec() to reject (simulate Redis failure). */
function mockPipelineReject(mockPipelineObj) {
  mockPipelineObj.exec.mockRejectedValueOnce(new Error("Redis connection refused"));
}

/** Build a fresh pipeline mock, wire it into redis.getClient, return the pipeline. */
function setupMockPipeline() {
  const pipeline = createMockPipeline();
  redisService.getClient.mockReturnValue({
    pipeline: jest.fn().mockReturnValue(pipeline),
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(),
    quit: jest.fn().mockResolvedValue(),
  });
  return pipeline;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getRateLimitConfig", () => {
  let getRateLimitConfig;

  beforeAll(() => {
    getRateLimitConfig = require("../../src/middleware/rateLimitConfig").getRateLimitConfig;
  });

  test("returns donation config for POST /api/donations", () => {
    const config = getRateLimitConfig("POST", "/api/donations");
    expect(config.points).toBe(10);
    expect(config.duration).toBe(60);
  });

  test("returns verification config for POST /api/verification-requests", () => {
    const config = getRateLimitConfig("POST", "/api/verification-requests");
    expect(config.points).toBe(10);
    expect(config.duration).toBe(900);
  });

  test("returns default config for unmatched endpoints", () => {
    const config = getRateLimitConfig("GET", "/api/unknown-endpoint");
    expect(config.points).toBe(150);
    expect(config.duration).toBe(900);
  });

  test("matches wildcard for /api/admin/*", () => {
    const config = getRateLimitConfig("GET", "/api/admin/some-action");
    expect(config.points).toBe(30);
    expect(config.duration).toBe(60);
  });

  test("matches method-specific wildcard for POST /api/admin/*", () => {
    const config = getRateLimitConfig("POST", "/api/admin/delete-user");
    // POST /api/admin/* is 20 req/min in the config (more specific)
    expect(config.points).toBe(20);
    expect(config.duration).toBe(60);
  });

  test("returns projects GET config for read-heavy endpoints", () => {
    const config = getRateLimitConfig("GET", "/api/projects/abc-123");
    expect(config.points).toBe(100);
    expect(config.duration).toBe(60);
  });

  test("returns registration config for POST /api/projects", () => {
    const config = getRateLimitConfig("POST", "/api/projects");
    expect(config.points).toBe(5);
    expect(config.duration).toBe(60);
  });

  test("handles trailing slashes correctly", () => {
    const config = getRateLimitConfig("POST", "/api/donations/");
    expect(config.points).toBe(10);
  });

  test("matches impact wildcard", () => {
    const config = getRateLimitConfig("GET", "/api/impact/certificate/abc");
    expect(config.points).toBe(60);
    expect(config.duration).toBe(60);
  });

  test("matches nested path under POST /api/admin/* via any-method fallback", () => {
    // POST /api/admin/settings/users — step 2 wildcard replaces only last
    // segment → POST /api/admin/settings/* (not in config). Step 3 should
    // still match /api/admin/* (any-method) or POST /api/admin/*.
    const config = getRateLimitConfig("POST", "/api/admin/settings/users");
    // Should match POST /api/admin/* (20 req/min) via step 3 iteration
    expect(config.points).toBe(20);
    expect(config.duration).toBe(60);
  });

  test("default for truly unmatched patterns", () => {
    const config = getRateLimitConfig("DELETE", "/api/unknown");
    expect(config.points).toBe(150);
  });
});

describe("slidingWindowRateLimit", () => {
  let slidingWindowRateLimit;

  beforeAll(() => {
    slidingWindowRateLimit = require("../../src/middleware/rateLimiter").slidingWindowRateLimit;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("allows requests under the limit", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 3],
      [null, 5],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:key", 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.limit).toBe(10);
    expect(typeof result.reset).toBe("number");
  });

  test("rejects requests over the limit", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 12],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:over", 10, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("returns correct remaining when exactly at limit", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 10],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:exact", 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  test("returns full capacity when no requests have been made", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 0],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:empty", 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
  });

  test("Uses pipeline for Redis commands", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 3],
      [null, 1],
    ]);

    await slidingWindowRateLimit("test:pipeline", 10, 60_000);
    expect(pipeline.zadd).toHaveBeenCalled();
    expect(pipeline.zremrangebyscore).toHaveBeenCalled();
    expect(pipeline.zcard).toHaveBeenCalled();
    expect(pipeline.expire).toHaveBeenCalled();
    expect(pipeline.exec).toHaveBeenCalled();
  });
});

describe("redisRateLimiter middleware", () => {
  let redisRateLimiter;
  let app;

  beforeAll(() => {
    redisRateLimiter = require("../../src/middleware/rateLimiter").redisRateLimiter;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(redisRateLimiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));
    app.post("/api/donations", (_req, res) => res.json({ ok: true }));
    return app;
  }

  test("sets X-RateLimit-* headers on allowed requests", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 3],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app).get("/api/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  test("returns 429 when over the limit", async () => {
    const pipeline = setupMockPipeline();
    // /api/test is not a known endpoint, so default config applies (150 req / 900s)
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 151],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app).get("/api/test");

    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error");
    expect(res.body).toHaveProperty("retryAfter");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  test("returns 200 under limit for POST /api/donations", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 5],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app)
      .post("/api/donations")
      .send({});

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
  });

  test("returns 429 on 11th POST /api/donations (11 > limit 10)", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 11],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app)
      .post("/api/donations")
      .send({});

    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error");
    expect(res.body).toHaveProperty("retryAfter");
  });
});

describe("Redis failure fallback", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("allows the request through when Redis is unavailable", async () => {
    const { redisRateLimiter } = require("../../src/middleware/rateLimiter");
    const pipeline = setupMockPipeline();
    mockPipelineReject(pipeline);

    app = express();
    app.use(redisRateLimiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
  });

  test("still sets X-RateLimit headers in degraded mode", async () => {
    const { redisRateLimiter } = require("../../src/middleware/rateLimiter");
    const pipeline = setupMockPipeline();
    mockPipelineReject(pipeline);

    app = express();
    app.use(redisRateLimiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
  });
});

describe("Legacy createRateLimiter (backward compat)", () => {
  let createRateLimiter;

  beforeAll(() => {
    createRateLimiter = require("../../src/middleware/rateLimiter").createRateLimiter;
  });

  function buildApp(maxRequests = 10, windowMinutes = 1) {
    const app = express();
    const limiter = createRateLimiter(maxRequests, windowMinutes);
    app.use(limiter);
    app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  test("allows up to max requests within the window", async () => {
    const app = buildApp(5, 1);
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/ping");
      expect(res.status).toBe(200);
    }
  });

  test("blocks the (max+1)th request with 429", async () => {
    const app = buildApp(3, 1);
    for (let i = 0; i < 3; i++) await request(app).get("/ping");

    const res = await request(app).get("/ping");
    expect(res.status).toBe(429);
  });

  test("sets Retry-After header on 429", async () => {
    const app = buildApp(1, 1);
    await request(app).get("/ping");
    const res = await request(app).get("/ping");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
