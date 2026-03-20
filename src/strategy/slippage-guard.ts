/**
 * Per-asset slippage monitoring and liquidity gating.
 *
 * Assets are classified into liquidity tiers:
 *   Tier 1 (SOL, BTC, ETH): deep markets, tight slippage limits
 *   Tier 2 (JTO, INJ, etc.): thin markets, wider limits + DLOB depth checks
 *
 * Before executing a trade, the guard:
 *   1. Checks DLOB depth at ±N bps — is there enough liquidity?
 *   2. Applies tier-specific max slippage
 *   3. Tracks actual execution slippage per asset
 *   4. Alerts if recent slippage exceeds thresholds
 */
import Decimal from "decimal.js";
import { BN } from "@drift-labs/sdk";
import { logger } from "../utils/logger";
import { getL2OrderBook, type L2OrderBook } from "../drift/orderbook";

// ── Config ──────────────────────────────────────────────────────

export type LiquidityTier = 1 | 2;

export interface SlippageGuardConfig {
  /** Per-asset tier overrides (defaults assigned by known assets) */
  tierOverrides: Record<string, LiquidityTier>;
  /** Tier 1: max slippage in bps before rejecting */
  tier1MaxSlippageBps: number;
  /** Tier 2: max slippage in bps before rejecting */
  tier2MaxSlippageBps: number;
  /** Tier 2: max single-order size as fraction of DLOB depth within 50bps */
  tier2MaxDepthFraction: number;
  /** Number of recent fills to track per asset */
  historySize: number;
  /** Alert threshold: mean slippage exceeds this in bps */
  alertThresholdBps: number;
}

const DEFAULT_CONFIG: SlippageGuardConfig = {
  tierOverrides: {},
  tier1MaxSlippageBps: 80,    // 0.80% max for deep markets
  tier2MaxSlippageBps: 150,   // 1.50% max for thin markets
  tier2MaxDepthFraction: 0.15, // max 15% of available depth in one order
  historySize: 20,
  alertThresholdBps: 50,
};

// Known tier assignments
const KNOWN_TIERS: Record<string, LiquidityTier> = {
  SOL: 1,
  BTC: 1,
  ETH: 1,
  JTO: 2,
  INJ: 2,
  WIF: 2,
  JUP: 2,
  PYTH: 2,
  BONK: 2,
  RNDR: 2,
  W: 2,
};

// ── Types ───────────────────────────────────────────────────────

export interface SlippageRecord {
  timestamp: number;
  asset: string;
  direction: "long" | "short";
  expectedPrice: number;
  executedPrice: number;
  slippageBps: number;
  sizeUsd: number;
}

export interface DepthCheck {
  asset: string;
  bidDepthUsd: number;
  askDepthUsd: number;
  oraclePrice: number;
  sufficient: boolean;
  maxSafeOrderUsd: number;
}

export interface PreTradeCheck {
  allowed: boolean;
  maxSlippageBps: number;
  tier: LiquidityTier;
  depthCheck?: DepthCheck;
  reason?: string;
}

// ── Slippage Guard ──────────────────────────────────────────────

export class SlippageGuard {
  private config: SlippageGuardConfig;
  private history: Map<string, SlippageRecord[]> = new Map();

  constructor(config: Partial<SlippageGuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the liquidity tier for an asset.
   */
  getTier(asset: string): LiquidityTier {
    return (
      this.config.tierOverrides[asset] ??
      KNOWN_TIERS[asset] ??
      2 // default to tier 2 (conservative) for unknown assets
    );
  }

  /**
   * Get the max allowed slippage for an asset based on its tier.
   */
  getMaxSlippageBps(asset: string): number {
    const tier = this.getTier(asset);
    return tier === 1
      ? this.config.tier1MaxSlippageBps
      : this.config.tier2MaxSlippageBps;
  }

  /**
   * Pre-trade check: should we proceed with this order?
   * For Tier 2 assets, checks DLOB depth to ensure sufficient liquidity.
   */
  async checkBeforeTrade(
    asset: string,
    direction: "long" | "short",
    sizeUsd: number
  ): Promise<PreTradeCheck> {
    const tier = this.getTier(asset);
    const maxSlippageBps = this.getMaxSlippageBps(asset);

    // Tier 1 assets: always allowed, just apply slippage cap
    if (tier === 1) {
      return { allowed: true, maxSlippageBps, tier };
    }

    // Tier 2 assets: check DLOB depth
    let depthCheck: DepthCheck | undefined;
    try {
      depthCheck = await this.checkDLOBDepth(asset, direction, sizeUsd);
    } catch (err) {
      logger.warn(`Slippage guard: DLOB depth check failed for ${asset}`, {
        error: String(err),
      });
      // On failure, allow with warning — don't block on DLOB API issues
      return {
        allowed: true,
        maxSlippageBps,
        tier,
        reason: "DLOB depth check failed — proceeding with caution",
      };
    }

    if (!depthCheck.sufficient) {
      return {
        allowed: false,
        maxSlippageBps,
        tier,
        depthCheck,
        reason:
          `Insufficient ${asset} DLOB depth: order $${sizeUsd.toFixed(0)} exceeds ` +
          `safe size $${depthCheck.maxSafeOrderUsd.toFixed(0)} ` +
          `(${direction} depth: $${direction === "long" ? depthCheck.askDepthUsd.toFixed(0) : depthCheck.bidDepthUsd.toFixed(0)})`,
      };
    }

    return { allowed: true, maxSlippageBps, tier, depthCheck };
  }

  /**
   * Record actual execution slippage for tracking and alerting.
   */
  recordSlippage(record: SlippageRecord): void {
    const history = this.history.get(record.asset) || [];
    history.push(record);

    // Keep only recent records
    if (history.length > this.config.historySize) {
      history.splice(0, history.length - this.config.historySize);
    }
    this.history.set(record.asset, history);

    // Alert if slippage is high
    if (record.slippageBps > this.config.alertThresholdBps) {
      logger.warn(
        `Slippage alert: ${record.asset} ${record.direction} slipped ${record.slippageBps.toFixed(1)}bps ` +
          `(threshold: ${this.config.alertThresholdBps}bps, size: $${record.sizeUsd.toFixed(0)})`
      );
    }

    // Check mean slippage
    const meanBps = this.getMeanSlippage(record.asset);
    if (meanBps > this.config.alertThresholdBps) {
      logger.warn(
        `Slippage trend alert: ${record.asset} mean slippage ${meanBps.toFixed(1)}bps ` +
          `over last ${history.length} fills exceeds ${this.config.alertThresholdBps}bps`
      );
    }
  }

  /**
   * Get mean slippage for an asset over recent fills.
   */
  getMeanSlippage(asset: string): number {
    const history = this.history.get(asset);
    if (!history || history.length === 0) return 0;
    const sum = history.reduce((acc, r) => acc + r.slippageBps, 0);
    return sum / history.length;
  }

  /**
   * Get slippage stats for all tracked assets.
   */
  getStats(): Array<{
    asset: string;
    tier: LiquidityTier;
    fillCount: number;
    meanSlippageBps: number;
    maxSlippageBps: number;
    lastSlippageBps: number;
  }> {
    const stats: Array<{
      asset: string;
      tier: LiquidityTier;
      fillCount: number;
      meanSlippageBps: number;
      maxSlippageBps: number;
      lastSlippageBps: number;
    }> = [];

    for (const [asset, history] of this.history.entries()) {
      if (history.length === 0) continue;
      const mean = history.reduce((s, r) => s + r.slippageBps, 0) / history.length;
      const max = Math.max(...history.map((r) => r.slippageBps));
      const last = history[history.length - 1].slippageBps;

      stats.push({
        asset,
        tier: this.getTier(asset),
        fillCount: history.length,
        meanSlippageBps: Math.round(mean * 10) / 10,
        maxSlippageBps: Math.round(max * 10) / 10,
        lastSlippageBps: Math.round(last * 10) / 10,
      });
    }

    return stats;
  }

  // ── Internal ──────────────────────────────────────────────────

  /**
   * Check DLOB depth for a given asset and order size.
   * Returns whether there's enough liquidity within acceptable slippage.
   */
  private async checkDLOBDepth(
    asset: string,
    direction: "long" | "short",
    sizeUsd: number
  ): Promise<DepthCheck> {
    const l2 = await getL2OrderBook(`${asset}-PERP`);

    // Parse oracle price (in PRICE_PRECISION = 1e6)
    const oraclePrice = l2.oracleData.price
      ? Number(l2.oracleData.price.toString()) / 1e6
      : 0;

    if (oraclePrice <= 0) {
      return {
        asset,
        bidDepthUsd: 0,
        askDepthUsd: 0,
        oraclePrice: 0,
        sufficient: false,
        maxSafeOrderUsd: 0,
      };
    }

    // Sum depth within 50bps of oracle on the relevant side
    const depthBpsWindow = 50;
    const bidDepthUsd = this.sumDepthWithinBps(
      l2.bids,
      oraclePrice,
      depthBpsWindow,
      "bid"
    );
    const askDepthUsd = this.sumDepthWithinBps(
      l2.asks,
      oraclePrice,
      depthBpsWindow,
      "ask"
    );

    const relevantDepth = direction === "long" ? askDepthUsd : bidDepthUsd;
    const maxSafeOrderUsd = relevantDepth * this.config.tier2MaxDepthFraction;
    const sufficient = sizeUsd <= maxSafeOrderUsd;

    return {
      asset,
      bidDepthUsd: Math.round(bidDepthUsd),
      askDepthUsd: Math.round(askDepthUsd),
      oraclePrice,
      sufficient,
      maxSafeOrderUsd: Math.round(maxSafeOrderUsd),
    };
  }

  /**
   * Sum order book depth (in USD) within a given bps window of oracle price.
   */
  private sumDepthWithinBps(
    levels: Array<{ price: BN; size: BN }>,
    oraclePrice: number,
    windowBps: number,
    side: "bid" | "ask"
  ): number {
    const threshold =
      side === "bid"
        ? oraclePrice * (1 - windowBps / 10_000)
        : oraclePrice * (1 + windowBps / 10_000);

    let totalUsd = 0;
    for (const level of levels) {
      const price = Number(level.price.toString()) / 1e6;
      const size = Number(level.size.toString()) / 1e9; // BASE_PRECISION

      if (side === "bid" && price < threshold) break;
      if (side === "ask" && price > threshold) break;

      totalUsd += price * size;
    }

    return totalUsd;
  }
}
