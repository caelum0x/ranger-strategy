import { RateLimiter } from "../utils/rate-limiter";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("RateLimiter", () => {
  it("allows burst of requests up to burst size", async () => {
    const limiter = new RateLimiter(10, 5);

    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    const elapsed = Date.now() - start;

    // All 5 should be instant (within burst)
    expect(elapsed).toBeLessThan(50);
  });

  it("throttles after burst is exhausted", async () => {
    const limiter = new RateLimiter(100, 2); // 100/sec, burst of 2

    // Consume burst
    await limiter.acquire();
    await limiter.acquire();

    const start = Date.now();
    await limiter.acquire(); // Should wait ~10ms (1/100 per sec)
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it("wraps async functions with rate limiting", async () => {
    const limiter = new RateLimiter(10, 5);
    let callCount = 0;

    const result = await limiter.wrap(async () => {
      callCount++;
      return 42;
    });

    expect(result).toBe(42);
    expect(callCount).toBe(1);
  });

  it("refills tokens over time", async () => {
    const limiter = new RateLimiter(1000, 2); // 1000/sec, burst of 2

    // Exhaust burst
    await limiter.acquire();
    await limiter.acquire();

    // Wait for refill (1ms per token at 1000/sec)
    await new Promise((r) => setTimeout(r, 10));

    const start = Date.now();
    await limiter.acquire(); // Should be immediate after refill
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(20);
  });
});
