/**
 * Raydium CLMM Liquidity Provider Strategy.
 *
 * Provides concentrated liquidity on Raydium CLMM pools for:
 *   - Trading fee income (proportional to volume in our range)
 *   - Farming rewards (if incentivized)
 *   - Tighter ranges = more capital efficiency + more fees
 *
 * Integrates with our delta-neutral strategy:
 *   - LP on SOL/USDC or BTC/USDC → earn fees
 *   - Hedge impermanent loss with Drift perp short
 *   - Net result: fee income + funding income - IL (hedged)
 *
 * Ported from:
 *   - src/plugins/raydium-plugin/ (pool creation)
 *   - src/plugins/raydium-clmm/ (CLMM program reference)
 *   - src/plugins/orca-plugin/ (whirlpool LP patterns)
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { config } from "../config";
import Decimal from "decimal.js";

// ── Types ───────────────────────────────────────────────────────

export interface LPPosition {
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  /** Lower price bound of our concentrated range */
  priceLower: Decimal;
  /** Upper price bound of our concentrated range */
  priceUpper: Decimal;
  /** Current pool price */
  currentPrice: Decimal;
  /** Our liquidity amount */
  liquidity: Decimal;
  /** Token A amount in position */
  tokenAAmount: Decimal;
  /** Token B amount in position */
  tokenBAmount: Decimal;
  /** Accumulated unclaimed fees (token A) */
  unclaimedFeesA: Decimal;
  /** Accumulated unclaimed fees (token B) */
  unclaimedFeesB: Decimal;
  /** Whether position is in range */
  inRange: boolean;
  /** NFT mint for the position (CLMM positions are NFTs) */
  positionNftMint?: string;
  /** Estimated APR from fees */
  feeAprEstimate: Decimal;
  /** Timestamp when position was opened */
  openedAt: number;
}

export interface LPStrategyConfig {
  /** Token pair (e.g., "SOL/USDC") */
  pair: string;
  /** Pool address (Raydium CLMM pool) */
  poolAddress: string;
  /** Range width as percentage around current price (e.g., 5 = ±5%) */
  rangeWidthPct: number;
  /** Maximum allocation to LP (as fraction of total capital) */
  maxAllocationPct: number;
  /** Minimum fee APR to keep position open */
  minFeeAprPct: number;
  /** Rebalance when price moves outside this % of range */
  rebalanceThresholdPct: number;
  /** Whether to hedge impermanent loss with perp short */
  hedgeIL: boolean;
  /** Perp market index for IL hedge */
  hedgePerpMarketIndex?: number;
}

const DEFAULT_LP_CONFIG: LPStrategyConfig = {
  pair: "SOL/USDC",
  poolAddress: "",
  rangeWidthPct: 5,
  maxAllocationPct: 0.15, // 15% of capital
  minFeeAprPct: 10,
  rebalanceThresholdPct: 80, // rebalance when 80% through range
  hedgeIL: true,
  hedgePerpMarketIndex: 0, // SOL-PERP
};

// ── Raydium LP Strategy ─────────────────────────────────────────

export class RaydiumLPStrategy {
  private connection: Connection;
  private configs: LPStrategyConfig[];
  private positions: Map<string, LPPosition> = new Map();
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private stats = {
    totalFeesEarned: new Decimal(0),
    totalRebalances: 0,
    positionsOpened: 0,
    positionsClosed: 0,
    ilHedgesPlaced: 0,
  };

  constructor(
    connection: Connection,
    configs: Partial<LPStrategyConfig>[] = [{}]
  ) {
    this.connection = connection;
    this.configs = configs.map((c) => ({ ...DEFAULT_LP_CONFIG, ...c }));
  }

  // ── Lifecycle ───────────────────────────────────────────────

  start(intervalMs = 60_000): void {
    if (this.running) return;
    this.running = true;

    this.intervalId = setInterval(() => {
      this.runCycle().catch((err) => {
        logger.warn("Raydium LP cycle error", { error: String(err) });
      });
    }, intervalMs);

    logger.info("Raydium LP strategy started", {
      pools: this.configs.map((c) => c.pair),
      rangeWidth: this.configs.map((c) => `±${c.rangeWidthPct}%`),
      hedgeIL: this.configs.map((c) => c.hedgeIL),
    });
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("Raydium LP strategy stopped", { stats: this.getStats() });
  }

  getStats() {
    return {
      ...this.stats,
      totalFeesEarned: this.stats.totalFeesEarned.toFixed(4),
      activePositions: this.positions.size,
      positions: Array.from(this.positions.values()).map((p) => ({
        pool: p.poolAddress.slice(0, 8),
        pair: `${p.tokenA}/${p.tokenB}`,
        inRange: p.inRange,
        feeApr: `${p.feeAprEstimate.toFixed(1)}%`,
        unclaimedFees: `$${p.unclaimedFeesB.toFixed(4)}`,
      })),
    };
  }

  getPositions(): LPPosition[] {
    return Array.from(this.positions.values());
  }

  // ── Core LP Cycle ─────────────────────────────────────────────

  private async runCycle(): Promise<void> {
    for (const lpConfig of this.configs) {
      if (!lpConfig.poolAddress) continue;

      const existing = this.positions.get(lpConfig.poolAddress);

      if (existing) {
        // Update existing position
        await this.updatePosition(lpConfig, existing);

        // Check if rebalance needed
        if (this.needsRebalance(lpConfig, existing)) {
          await this.rebalancePosition(lpConfig, existing);
        }

        // Claim fees periodically
        if (
          existing.unclaimedFeesA.gt(0) ||
          existing.unclaimedFeesB.gt(0)
        ) {
          await this.claimFees(existing);
        }
      } else {
        // Open new position if we don't have one
        await this.openPosition(lpConfig);
      }
    }
  }

  // ── Position Management ───────────────────────────────────────

  private async openPosition(lpConfig: LPStrategyConfig): Promise<void> {
    try {
      // Fetch current pool price
      const currentPrice = await this.getPoolPrice(lpConfig.poolAddress);
      if (!currentPrice || currentPrice.lte(0)) return;

      // Calculate concentrated range
      const rangeMultiplier = new Decimal(lpConfig.rangeWidthPct).div(100);
      const priceLower = currentPrice.mul(new Decimal(1).sub(rangeMultiplier));
      const priceUpper = currentPrice.mul(new Decimal(1).add(rangeMultiplier));

      logger.info("Opening Raydium LP position", {
        pair: lpConfig.pair,
        currentPrice: currentPrice.toFixed(4),
        range: `${priceLower.toFixed(4)} — ${priceUpper.toFixed(4)}`,
        hedgeIL: lpConfig.hedgeIL,
      });

      // In production, this would:
      // 1. Calculate optimal token amounts for the range
      // 2. Call Raydium CLMM SDK to open position
      // 3. If hedgeIL, place a perp short on Drift
      // For now, record the intended position

      const position: LPPosition = {
        poolAddress: lpConfig.poolAddress,
        tokenA: lpConfig.pair.split("/")[0],
        tokenB: lpConfig.pair.split("/")[1],
        priceLower,
        priceUpper,
        currentPrice,
        liquidity: new Decimal(0),
        tokenAAmount: new Decimal(0),
        tokenBAmount: new Decimal(0),
        unclaimedFeesA: new Decimal(0),
        unclaimedFeesB: new Decimal(0),
        inRange: true,
        feeAprEstimate: new Decimal(0),
        openedAt: Date.now(),
      };

      this.positions.set(lpConfig.poolAddress, position);
      this.stats.positionsOpened++;

      logger.info("Raydium LP position opened", {
        pair: lpConfig.pair,
        range: `${priceLower.toFixed(4)} — ${priceUpper.toFixed(4)}`,
      });
    } catch (err) {
      logger.warn("Failed to open LP position", {
        pair: lpConfig.pair,
        error: String(err),
      });
    }
  }

  private async updatePosition(
    lpConfig: LPStrategyConfig,
    position: LPPosition
  ): Promise<void> {
    try {
      const currentPrice = await this.getPoolPrice(lpConfig.poolAddress);
      if (!currentPrice) return;

      position.currentPrice = currentPrice;
      position.inRange =
        currentPrice.gte(position.priceLower) &&
        currentPrice.lte(position.priceUpper);

      if (!position.inRange) {
        logger.warn("LP position out of range", {
          pair: lpConfig.pair,
          currentPrice: currentPrice.toFixed(4),
          range: `${position.priceLower.toFixed(4)} — ${position.priceUpper.toFixed(4)}`,
        });
      }
    } catch {
      // Non-critical
    }
  }

  private needsRebalance(
    lpConfig: LPStrategyConfig,
    position: LPPosition
  ): boolean {
    if (!position.inRange) return true;

    // Calculate how far through the range we are
    const rangeSize = position.priceUpper.sub(position.priceLower);
    if (rangeSize.lte(0)) return false;

    const priceOffset = position.currentPrice.sub(position.priceLower);
    const rangePct = priceOffset.div(rangeSize).mul(100);

    // Rebalance if we're past the threshold on either side
    return (
      rangePct.gt(lpConfig.rebalanceThresholdPct) ||
      rangePct.lt(100 - lpConfig.rebalanceThresholdPct)
    );
  }

  private async rebalancePosition(
    lpConfig: LPStrategyConfig,
    position: LPPosition
  ): Promise<void> {
    logger.info("Rebalancing LP position", {
      pair: lpConfig.pair,
      currentPrice: position.currentPrice.toFixed(4),
      oldRange: `${position.priceLower.toFixed(4)} — ${position.priceUpper.toFixed(4)}`,
    });

    // Calculate new range centered on current price
    const rangeMultiplier = new Decimal(lpConfig.rangeWidthPct).div(100);
    position.priceLower = position.currentPrice.mul(
      new Decimal(1).sub(rangeMultiplier)
    );
    position.priceUpper = position.currentPrice.mul(
      new Decimal(1).add(rangeMultiplier)
    );
    position.inRange = true;

    this.stats.totalRebalances++;

    logger.info("LP position rebalanced", {
      pair: lpConfig.pair,
      newRange: `${position.priceLower.toFixed(4)} — ${position.priceUpper.toFixed(4)}`,
    });

    // In production: close old position NFT, open new one at new range
    // + adjust perp hedge size if hedgeIL is enabled
  }

  private async claimFees(position: LPPosition): Promise<void> {
    const totalFees = position.unclaimedFeesA.add(position.unclaimedFeesB);
    if (totalFees.gt(0)) {
      this.stats.totalFeesEarned = this.stats.totalFeesEarned.add(totalFees);
      logger.info("LP fees claimed", {
        pool: position.poolAddress.slice(0, 8),
        feesA: position.unclaimedFeesA.toFixed(6),
        feesB: position.unclaimedFeesB.toFixed(6),
      });
      position.unclaimedFeesA = new Decimal(0);
      position.unclaimedFeesB = new Decimal(0);
    }
    // In production: call Raydium CLMM collectFees instruction
  }

  // ── Pool Data ─────────────────────────────────────────────────

  private async getPoolPrice(poolAddress: string): Promise<Decimal | null> {
    try {
      // In production: fetch pool state from on-chain and calculate price
      // from sqrtPriceX64. For now, use oracle price as proxy.
      // TODO: Implement actual CLMM pool price fetching
      return null;
    } catch {
      return null;
    }
  }
}
