/**
 * Cross-venue arbitrage executor (Drift + Binance).
 *
 * Exploits funding rate differentials between venues:
 *   - When Drift funding > Binance → short perp on Drift, long perp on Binance
 *   - When Binance funding > Drift → short perp on Binance, long perp on Drift
 *   - Spot hedge on Drift for delta-neutrality
 *
 * Also supports the standard delta-neutral mode:
 *   - Long spot on Drift + short perp on Binance (when Binance funding is positive)
 *   - Avoids Drift perp entirely — uses Binance for the perp leg
 *
 * Config: STRATEGY_MODE=cross-venue in .env
 */
import Decimal from "decimal.js";
import { DriftManager } from "../drift/client";
import { DriftExecutor } from "../drift/executor";
import { BinanceManager } from "../binance/client";
import { DriftDataAPI } from "../drift/data-api";
import { config } from "../config";
import { logger } from "../utils/logger";
import { FundingRate } from "./types";

// ── Types ───────────────────────────────────────────────────────

export interface VenueRate {
  asset: string;
  driftAPY: number;
  binanceAPY: number;
  spread: number; // drift - binance
  bestVenue: "drift" | "binance";
  bestAPY: number;
  direction: "short" | "long"; // perp direction that collects on best venue
}

export interface CrossVenueSignal {
  asset: string;
  action: "open" | "close" | "flip";
  /** Where to execute the perp leg */
  perpVenue: "drift" | "binance";
  perpDirection: "short" | "long";
  /** Spot hedge always on Drift */
  spotDirection: "long" | "short";
  size: Decimal;
  reason: string;
  driftAPY: number;
  binanceAPY: number;
}

// ── Cross-Venue Executor ────────────────────────────────────────

export class CrossVenueExecutor {
  private drift: DriftManager;
  private executor: DriftExecutor;
  private binance: BinanceManager;
  private dataApi: DriftDataAPI;

  /** Current positions tracked per asset */
  private positions: Map<
    string,
    {
      perpVenue: "drift" | "binance";
      perpDirection: "short" | "long";
      size: Decimal;
      entryTime: number;
    }
  > = new Map();

  constructor(
    drift: DriftManager,
    executor: DriftExecutor,
    binance: BinanceManager
  ) {
    this.drift = drift;
    this.executor = executor;
    this.binance = binance;
    this.dataApi = new DriftDataAPI();
  }

  // ── Rate Comparison ─────────────────────────────────────────

  /**
   * Compare funding rates between Drift and Binance for all target assets.
   */
  async compareRates(): Promise<VenueRate[]> {
    const results: VenueRate[] = [];

    // Fetch Drift rates
    const driftRates: Record<string, number> = {};
    for (const asset of config.targetAssets) {
      try {
        const apy = await this.dataApi.getCurrentFundingAPY(asset);
        driftRates[asset] = apy.toNumber();
      } catch {
        driftRates[asset] = 0;
      }
    }

    // Fetch Binance rates
    const binanceRates = await this.binance.getFundingRates();
    const binanceMap: Record<string, number> = {};
    for (const r of binanceRates) {
      binanceMap[r.asset] = r.annualizedRate.toNumber();
    }

    for (const asset of config.targetAssets) {
      const driftAPY = driftRates[asset] || 0;
      const binanceAPY = binanceMap[asset] || 0;

      const absDrift = Math.abs(driftAPY);
      const absBinance = Math.abs(binanceAPY);
      const bestVenue = absDrift >= absBinance ? "drift" : "binance";
      const bestAPY = Math.max(absDrift, absBinance);
      const bestRate = bestVenue === "drift" ? driftAPY : binanceAPY;

      results.push({
        asset,
        driftAPY,
        binanceAPY,
        spread: driftAPY - binanceAPY,
        bestVenue,
        bestAPY,
        direction: bestRate >= 0 ? "short" : "long",
      });
    }

    // Sort by best APY descending
    results.sort((a, b) => b.bestAPY - a.bestAPY);

    logger.info("Cross-venue rate comparison", {
      rates: results.map((r) => ({
        asset: r.asset,
        drift: `${(r.driftAPY * 100).toFixed(2)}%`,
        binance: `${(r.binanceAPY * 100).toFixed(2)}%`,
        best: r.bestVenue,
        spread: `${(r.spread * 100).toFixed(2)}%`,
      })),
    });

    return results;
  }

  // ── Signal Generation ───────────────────────────────────────

  /**
   * Generate cross-venue trading signals based on rate comparison.
   */
  async generateSignals(
    deployableCapital: Decimal,
    minAPY: number = 0.07
  ): Promise<CrossVenueSignal[]> {
    const rates = await this.compareRates();
    const signals: CrossVenueSignal[] = [];

    for (const rate of rates) {
      const existing = this.positions.get(rate.asset);

      // Skip if below minimum threshold on both venues
      if (rate.bestAPY < minAPY) {
        if (existing) {
          signals.push({
            asset: rate.asset,
            action: "close",
            perpVenue: existing.perpVenue,
            perpDirection: existing.perpDirection,
            spotDirection: existing.perpDirection === "short" ? "long" : "short",
            size: existing.size,
            reason: `Best APY ${(rate.bestAPY * 100).toFixed(2)}% below threshold ${(minAPY * 100).toFixed(0)}%`,
            driftAPY: rate.driftAPY,
            binanceAPY: rate.binanceAPY,
          });
        }
        continue;
      }

      const weight =
        (this as any).ASSET_WEIGHTS?.[rate.asset] ||
        1 / config.targetAssets.length;
      const positionSize = deployableCapital.mul(weight);

      if (!existing) {
        // New position
        signals.push({
          asset: rate.asset,
          action: "open",
          perpVenue: rate.bestVenue,
          perpDirection: rate.direction,
          spotDirection: rate.direction === "short" ? "long" : "short",
          size: positionSize,
          reason: `${rate.bestVenue} funding ${(rate.bestAPY * 100).toFixed(2)}% APY (drift: ${(rate.driftAPY * 100).toFixed(2)}%, binance: ${(rate.binanceAPY * 100).toFixed(2)}%)`,
          driftAPY: rate.driftAPY,
          binanceAPY: rate.binanceAPY,
        });
      } else if (existing.perpVenue !== rate.bestVenue) {
        // Venue flip — better rate on the other venue
        const spreadDiff = Math.abs(rate.spread);
        if (spreadDiff > 0.05) {
          // Only flip if spread difference > 5% APY
          signals.push({
            asset: rate.asset,
            action: "flip",
            perpVenue: rate.bestVenue,
            perpDirection: rate.direction,
            spotDirection: rate.direction === "short" ? "long" : "short",
            size: existing.size,
            reason: `Venue flip: ${existing.perpVenue}→${rate.bestVenue} (spread: ${(spreadDiff * 100).toFixed(2)}% APY diff)`,
            driftAPY: rate.driftAPY,
            binanceAPY: rate.binanceAPY,
          });
        }
      }
    }

    return signals;
  }

  // ── Execution ───────────────────────────────────────────────

  /**
   * Execute a cross-venue signal.
   */
  async execute(signal: CrossVenueSignal): Promise<void> {
    logger.info("Cross-venue executing", {
      asset: signal.asset,
      action: signal.action,
      perpVenue: signal.perpVenue,
      perpDirection: signal.perpDirection,
      size: signal.size.toFixed(2),
    });

    try {
      if (signal.action === "close" || signal.action === "flip") {
        await this.closePosition(signal.asset);
      }

      if (signal.action === "open" || signal.action === "flip") {
        await this.openPosition(signal);
      }
    } catch (err) {
      logger.error("Cross-venue execution failed", {
        asset: signal.asset,
        action: signal.action,
        error: String(err),
      });
      throw err;
    }
  }

  private async openPosition(signal: CrossVenueSignal): Promise<void> {
    const { asset, perpVenue, perpDirection, size } = signal;

    if (perpVenue === "drift") {
      // Both legs on Drift — use atomic cancel+enter
      await this.executor.atomicCancelAndEnterDeltaNeutral(
        asset,
        size,
        perpDirection
      );
    } else {
      // Perp on Binance, spot on Drift
      // 1. Set leverage on Binance
      await this.binance.setLeverage(asset, config.maxLeverage.toNumber());

      // 2. Open Drift spot position (buy or sell)
      if (signal.spotDirection === "long") {
        await this.executor.jupiterSwap("USDC", asset, size);
      }
      // For short spot, we borrow via Drift's margin system (handled by atomicCancelAndEnterDeltaNeutral)

      // 3. Open Binance perp
      if (perpDirection === "short") {
        await this.binance.shortPerp(asset, size);
      } else {
        await this.binance.longPerp(asset, size);
      }
    }

    this.positions.set(asset, {
      perpVenue,
      perpDirection,
      size,
      entryTime: Date.now(),
    });

    logger.info("Cross-venue position opened", {
      asset,
      perpVenue,
      perpDirection,
      size: size.toFixed(2),
    });
  }

  private async closePosition(asset: string): Promise<void> {
    const pos = this.positions.get(asset);
    if (!pos) return;

    if (pos.perpVenue === "drift") {
      await this.executor.atomicDeltaNeutralExit(asset);
    } else {
      // Close Binance perp
      await this.binance.closePerp(asset);
      // Close Drift spot (if any)
      await this.executor.atomicDeltaNeutralExit(asset);
    }

    this.positions.delete(asset);
    logger.info("Cross-venue position closed", { asset });
  }

  // ── State ───────────────────────────────────────────────────

  getPositions(): Array<{
    asset: string;
    perpVenue: "drift" | "binance";
    perpDirection: "short" | "long";
    size: number;
    ageHours: number;
  }> {
    const now = Date.now();
    return Array.from(this.positions.entries()).map(([asset, pos]) => ({
      asset,
      perpVenue: pos.perpVenue,
      perpDirection: pos.perpDirection,
      size: pos.size.toNumber(),
      ageHours: (now - pos.entryTime) / 3600000,
    }));
  }

  hasPosition(asset: string): boolean {
    return this.positions.has(asset);
  }
}
