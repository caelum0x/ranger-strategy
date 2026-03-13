/**
 * Oracle price divergence guard.
 *
 * Monitors oracle-mark price spread and flags when it's too wide.
 * Wide spreads can indicate:
 * - Stale oracle (dangerous for trading)
 * - High volatility period (risky to enter)
 * - Potential oracle manipulation
 *
 * Used as a pre-trade check to avoid entering with bad pricing.
 */
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

export interface OracleCheck {
  asset: string;
  oraclePrice: Decimal;
  markPrice: Decimal;
  spreadPct: Decimal;
  safe: boolean;
  reason?: string;
}

export class OracleGuard {
  /** Maximum acceptable oracle-mark spread (basis points) */
  private readonly maxSpreadBps: Decimal;
  /** Minimum oracle confidence (0-1) for trading */
  private readonly minConfidence: Decimal;
  /** Track last known prices for staleness detection */
  private lastPrices: Map<string, { price: Decimal; timestamp: number }> =
    new Map();

  constructor(
    maxSpreadBps: Decimal = new Decimal(50), // 50 bps = 0.5%
    minConfidence: Decimal = new Decimal("0.95")
  ) {
    this.maxSpreadBps = maxSpreadBps;
    this.minConfidence = minConfidence;
  }

  /**
   * Check if oracle-mark spread is safe for trading.
   */
  check(
    asset: string,
    oraclePrice: Decimal,
    markPrice: Decimal
  ): OracleCheck {
    if (oraclePrice.isZero() || markPrice.isZero()) {
      return {
        asset,
        oraclePrice,
        markPrice,
        spreadPct: new Decimal(100),
        safe: false,
        reason: "Zero price detected",
      };
    }

    const spread = markPrice.sub(oraclePrice).div(oraclePrice).abs();
    const spreadBps = spread.mul(10000);
    const safe = spreadBps.lte(this.maxSpreadBps);

    // Check staleness
    const lastKnown = this.lastPrices.get(asset);
    let stale = false;
    if (lastKnown) {
      const ageMs = Date.now() - lastKnown.timestamp;
      if (ageMs > 60_000) {
        // > 1 minute since last update
        stale = true;
      }
    }

    this.lastPrices.set(asset, {
      price: oraclePrice,
      timestamp: Date.now(),
    });

    const reason = !safe
      ? `Oracle-mark spread ${spreadBps.toFixed(1)} bps exceeds max ${this.maxSpreadBps.toFixed(0)} bps`
      : stale
        ? `Oracle may be stale (>1 min since last update)`
        : undefined;

    if (!safe) {
      logger.warn(`Oracle guard: ${asset} spread too wide`, {
        oracle: oraclePrice.toFixed(2),
        mark: markPrice.toFixed(2),
        spreadBps: spreadBps.toFixed(1),
        maxBps: this.maxSpreadBps.toFixed(0),
      });
    }

    return {
      asset,
      oraclePrice,
      markPrice,
      spreadPct: spread.mul(100),
      safe: safe && !stale,
      reason,
    };
  }

  /**
   * Batch check all assets. Returns false if any asset is unsafe.
   */
  checkAll(
    assets: Array<{
      asset: string;
      oraclePrice: Decimal;
      markPrice: Decimal;
    }>
  ): { allSafe: boolean; checks: OracleCheck[] } {
    const checks = assets.map((a) =>
      this.check(a.asset, a.oraclePrice, a.markPrice)
    );
    return {
      allSafe: checks.every((c) => c.safe),
      checks,
    };
  }
}
