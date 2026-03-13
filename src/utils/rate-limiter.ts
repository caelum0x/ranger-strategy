/**
 * Simple token-bucket rate limiter for RPC calls.
 *
 * Drift and Solana RPC providers rate-limit aggressively.
 * This ensures we stay within bounds (default: 10 requests/sec).
 */
import { logger } from "./logger";

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private waiting: Array<() => void> = [];

  constructor(
    maxRequestsPerSecond: number = 10,
    burstSize: number = 20
  ) {
    this.maxTokens = burstSize;
    this.tokens = burstSize;
    this.refillRatePerMs = maxRequestsPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRatePerMs
    );
    this.lastRefill = now;
  }

  /**
   * Wait until a token is available, then consume it.
   * Returns immediately if tokens are available.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for a token to become available
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.refill();
        this.tokens = Math.max(0, this.tokens - 1);
        resolve();
      }, waitMs);
    });
  }

  /**
   * Wrap an async function with rate limiting.
   */
  wrap<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    return this.acquire().then(() => {
      if (label) {
        logger.info(`Rate limiter: executing ${label}`);
      }
      return fn();
    });
  }
}

/** Shared Solana RPC rate limiter */
export const solanaRpcLimiter = new RateLimiter(10, 20);

/** Shared Drift Data API rate limiter */
export const driftApiLimiter = new RateLimiter(5, 10);
