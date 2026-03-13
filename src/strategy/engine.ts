import Decimal from "decimal.js";
import { DriftManager } from "../drift/client";
import { DriftFundingAnalyzer, FundingAnalysis } from "../drift/funding";
import { DriftExecutor } from "../drift/executor";
import { DriftDataAPI } from "../drift/data-api";
import { BinanceManager } from "../binance/client";
import { RiskManager } from "../risk/manager";
import { config } from "../config";
import {
  FundingRate,
  MarketRegime,
  Position,
  StrategyState,
  TradeSignal,
} from "./types";
import { logger } from "../utils/logger";

export class StrategyEngine {
  private drift: DriftManager;
  private binance: BinanceManager | null;
  private riskManager: RiskManager;
  private fundingAnalyzer: DriftFundingAnalyzer | null = null;
  private executor: DriftExecutor | null = null;
  private dataApi: DriftDataAPI = new DriftDataAPI();
  private state: StrategyState;
  private lastFundingSnapshot: Decimal = new Decimal(0);
  private startTime: number = Date.now();
  private totalLendingCollected: Decimal = new Decimal(0);

  constructor(
    drift: DriftManager,
    binance: BinanceManager | null,
    initialCapital: Decimal
  ) {
    this.drift = drift;
    this.binance = binance;
    this.riskManager = new RiskManager(initialCapital);

    this.state = {
      totalCapital: initialCapital,
      deployedCapital: new Decimal(0),
      idleCapital: initialCapital,
      positions: [],
      totalPnl: new Decimal(0),
      totalFundingCollected: new Decimal(0),
      currentDrawdown: new Decimal(0),
      maxDrawdownHit: new Decimal(0),
      healthRatio: new Decimal(999),
      apyEstimate: new Decimal(0),
      lastRebalance: 0,
      regime: "neutral",
    };
  }

  /**
   * Swap the Drift client (used when switching to vault delegate mode).
   */
  setDrift(drift: DriftManager): void {
    this.drift = drift;
  }

  /**
   * Attach the on-chain funding analyzer (requires initialized DriftClient).
   */
  setFundingAnalyzer(analyzer: DriftFundingAnalyzer): void {
    this.fundingAnalyzer = analyzer;
  }

  /**
   * Attach the advanced executor for atomic tx execution.
   */
  setExecutor(executor: DriftExecutor): void {
    this.executor = executor;
  }

  async runCycle(): Promise<void> {
    logger.info("=== Strategy cycle starting ===");

    // 1. Update state
    await this.refreshState();

    // 2. Check risk — emergency unwind if needed
    if (this.riskManager.shouldEmergencyUnwind(this.state)) {
      logger.error("EMERGENCY UNWIND triggered");
      await this.emergencyUnwind();
      return;
    }

    // 3. Risk check
    const riskCheck = this.riskManager.checkRisk(this.state);
    if (!riskCheck.passed) {
      logger.warn("Risk check failed, reducing positions", {
        violations: riskCheck.violations,
      });
      await this.reducePositions();
      return;
    }

    // 4. Get funding rates
    const driftRates = await this.drift.getFundingRates();
    const binanceRates =
      this.binance && config.strategyMode === "cross-venue"
        ? await this.binance.getFundingRates()
        : [];

    // 4.5. Detect market regime and update state
    const allRates = [...driftRates, ...binanceRates];
    this.state.regime = this.detectRegime(allRates);
    logger.info(`Market regime: ${this.state.regime}`);

    // 5. Generate trade signals
    const signals = this.generateSignals(driftRates, binanceRates);

    // 6. Settlement-aware timing: skip trade execution if we're close
    //      to funding settlement (within 5 min) to avoid paying in the
    //      wrong direction. Let settlement happen first.
    const nearSettlement = driftRates.some((r) => {
      const msUntilSettlement = r.nextSettlement - Date.now();
      return msUntilSettlement > 0 && msUntilSettlement < 5 * 60 * 1000;
    });
    if (nearSettlement && signals.length > 0) {
      logger.info(
        "Near funding settlement — deferring trade execution to next cycle"
      );
    } else {
      // 6. Execute signals (only when not near settlement)
      for (const signal of signals) {
        await this.executeSignal(signal);
      }
    }

    // 7. Track funding collected
    const fundingPnl = this.drift.getUnrealizedFundingPnl();
    const newFunding = fundingPnl.sub(this.lastFundingSnapshot);
    if (newFunding.gt(0)) {
      this.state.totalFundingCollected =
        this.state.totalFundingCollected.add(newFunding);
    }
    this.lastFundingSnapshot = fundingPnl;

    // 7.1. Settle funding on Drift
    await this.drift.settleFunding();

    // 7.2. Track lending yield on spot deposits
    await this.trackLendingYield();

    // 7.5. Settle PnL via executor if available
    if (this.executor) {
      try {
        await this.executor.settlePnl([0, 1, 2]); // SOL, BTC, ETH
      } catch {
        // Non-critical — PnL settlement may have nothing to settle
      }
    }

    // 8. Update state again
    await this.refreshState();

    // 9. Update last rebalance timestamp and estimate APY
    this.state.lastRebalance = Date.now();
    const elapsedMs = Date.now() - this.startTime;
    const elapsedDays = elapsedMs / (86400 * 1000);
    if (elapsedDays > 0 && this.state.totalCapital.gt(0)) {
      const totalYield = this.state.totalFundingCollected.add(
        this.totalLendingCollected
      );
      const returnSoFar = totalYield.div(this.state.totalCapital);
      this.state.apyEstimate = returnSoFar
        .div(elapsedDays)
        .mul(365.25)
        .mul(100);
    }

    logger.info("=== Strategy cycle complete ===", {
      mode: config.strategyMode,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      positions: this.state.positions.length,
      apyEstimate: `${this.state.apyEstimate.toFixed(2)}%`,
      fundingCollected: `$${this.state.totalFundingCollected.toFixed(4)}`,
      lendingCollected: `$${this.totalLendingCollected.toFixed(4)}`,
      regime: this.state.regime,
    });
  }

  generateSignals(
    driftRates: FundingRate[],
    binanceRates: FundingRate[]
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const isDriftOnly = config.strategyMode === "drift-only";

    // Use on-chain funding analysis if available
    const onChainAnalyses = this.fundingAnalyzer
      ? this.fundingAnalyzer.analyzeAllAssets()
      : [];

    // Rank assets by funding yield — bi-directional (positive OR negative)
    const rankedAssets = config.targetAssets
      .map((asset) => {
        const binanceRate = binanceRates.find((r) => r.asset === asset);
        const driftRate = driftRates.find((r) => r.asset === asset);
        const onChain = onChainAnalyses.find((a) => a.asset === asset);

        // Determine funding direction and yield
        // In drift-only mode, use Drift rates; in cross-venue, use best of both
        const primaryRate = isDriftOnly
          ? driftRate?.annualizedRate || new Decimal(0)
          : binanceRate?.annualizedRate || new Decimal(0);

        // Absolute yield — we can profit from both positive and negative funding
        const absYield = primaryRate.abs();

        // Which direction to take:
        // positive funding → short perp (shorts collect) + long spot
        // negative funding → long perp (longs collect) + short spot
        const perpSide: "short" | "long" = primaryRate.gte(0) ? "short" : "long";
        const spotSide: "short" | "long" = perpSide === "short" ? "long" : "short";

        const confidence = onChain
          ? onChain.confidence
          : new Decimal("0.5");

        // Use on-chain bi-directional attractiveness when available
        const isAttractive = onChain
          ? onChain.isAttractive
          : absYield.gt(config.minFundingAPY);

        // Momentum bonus: rising funding in our direction is extra attractive
        const momentumBonus = onChain?.momentumScore || new Decimal(0);

        return {
          asset,
          primaryRate,
          absYield,
          perpSide,
          spotSide,
          onChainAnalysis: onChain,
          confidence,
          isAttractive,
          momentum: onChain?.momentum || ("flat" as const),
          momentumBonus,
          driftFunding: driftRate?.annualizedRate || new Decimal(0),
          binanceFunding: binanceRate?.annualizedRate || new Decimal(0),
        };
      })
      .filter((a) => a.isAttractive && a.absYield.gt(config.minFundingAPY))
      .sort((a, b) => b.absYield.minus(a.absYield).toNumber());

    logger.info("Asset ranking (bi-directional funding)", {
      mode: config.strategyMode,
      assets: rankedAssets.map((a) => ({
        asset: a.asset,
        rate: a.primaryRate.toFixed(4),
        absYield: a.absYield.toFixed(4),
        perpSide: a.perpSide,
        momentum: a.momentum,
        confidence: a.confidence.toFixed(2),
      })),
    });

    // Check existing positions — close if no longer attractive or direction flipped
    for (const pos of this.state.positions) {
      const ranked = rankedAssets.find((a) => a.asset === pos.asset);

      // Close if asset is no longer attractive
      if (!ranked) {
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: pos.side === "long" ? "long" : "short",
          perpSide: pos.side === "long" ? "short" : "long",
          spotSize: pos.size,
          perpSize: pos.size,
          confidence: new Decimal(1),
          reason: "Funding rate no longer attractive",
          predictedFundingRate: new Decimal(0),
        });
      }
    }

    // Open positions for attractive assets
    for (const ranked of rankedAssets) {
      const existingPos = this.state.positions.find(
        (p) => p.asset === ranked.asset && p.venue === "drift"
      );

      if (!existingPos && this.state.idleCapital.gt(new Decimal(5))) {
        const positionSize = this.riskManager.calculatePositionSize(
          this.state.idleCapital,
          ranked.asset,
          ranked.absYield,
          ranked.confidence
        );

        if (positionSize.gte(new Decimal(5))) {
          const premium = ranked.onChainAnalysis
            ? ` | premium: ${ranked.onChainAnalysis.premium.mul(100).toFixed(3)}%`
            : "";
          const momentumStr = ranked.momentum !== "flat"
            ? ` | momentum: ${ranked.momentum}`
            : "";

          signals.push({
            asset: ranked.asset,
            action: "open",
            spotVenue: "drift",
            perpVenue: isDriftOnly ? "drift" : "binance",
            spotSide: ranked.spotSide,
            perpSide: ranked.perpSide,
            spotSize: positionSize,
            perpSize: positionSize,
            confidence: ranked.confidence,
            reason: `${ranked.perpSide} perp: ${ranked.primaryRate.toFixed(4)} annualized${premium}${momentumStr}`,
            predictedFundingRate: ranked.primaryRate,
          });
        }
      }
    }

    return signals;
  }

  async executeSignal(signal: TradeSignal): Promise<void> {
    logger.info(`Executing signal: ${signal.action} ${signal.asset}`, {
      signal: {
        asset: signal.asset,
        action: signal.action,
        spotSide: signal.spotSide,
        perpSide: signal.perpSide,
        perpVenue: signal.perpVenue,
        spotSize: signal.spotSize.toFixed(4),
        reason: signal.reason,
      },
    });

    try {
      switch (signal.action) {
        case "open":
          await this.executeOpen(signal);
          break;

        case "close":
          await this.executeClose(signal);
          break;

        case "rebalance":
          // Adjust sizes — close and re-open with new direction
          await this.executeClose(signal);
          await this.executeOpen(signal);
          break;

        default:
          logger.warn(`Unknown signal action: ${signal.action}`);
      }
    } catch (err) {
      logger.error(`Failed to execute signal for ${signal.asset}`, {
        error: err,
        signal,
      });
    }
  }

  private async executeOpen(signal: TradeSignal): Promise<void> {
    // Use atomic entry via executor when available (slippage-protected)
    if (this.executor && signal.perpVenue === "drift") {
      // Atomic cancel + delta-neutral entry in single tx
      await this.executor.atomicCancelAndEnterDeltaNeutral(
        signal.asset,
        signal.spotSize
      );
    } else {
      // Fallback: separate spot and perp legs
      // Spot leg on Drift
      if (signal.spotSide === "long") {
        await this.drift.buySpot(signal.asset, signal.spotSize);
      } else {
        // Short spot = borrow and sell (margin trade on Drift)
        await this.drift.sellSpot(signal.asset, signal.spotSize);
      }

      // Perp leg — on Drift or Binance depending on mode
      if (signal.perpVenue === "drift") {
        if (signal.perpSide === "short") {
          await this.drift.shortPerp(signal.asset, signal.perpSize);
        } else {
          await this.drift.longPerp(signal.asset, signal.perpSize);
        }
      } else if (this.binance) {
        if (signal.perpSide === "short") {
          await this.binance.shortPerp(signal.asset, signal.perpSize);
        } else {
          // Binance long perp (for negative funding collection)
          await this.binance.shortPerp(signal.asset, signal.perpSize.neg());
        }
      }
    }

    this.state.deployedCapital = this.state.deployedCapital.add(
      signal.spotSize
    );
    this.state.idleCapital = this.state.idleCapital.sub(signal.spotSize);
  }

  private async executeClose(signal: TradeSignal): Promise<void> {
    // Close perp leg first (faster on CEX)
    if (signal.perpVenue === "drift") {
      if (this.executor) {
        await this.executor.atomicDeltaNeutralExit(signal.asset);
      } else {
        await this.drift.closePerp(signal.asset);
        // Close spot
        if (signal.spotSide === "long") {
          await this.drift.sellSpot(signal.asset, signal.spotSize);
        } else {
          await this.drift.buySpot(signal.asset, signal.spotSize);
        }
      }
    } else if (this.binance) {
      await this.binance.closePerp(signal.asset);
      // Close Drift spot
      if (signal.spotSide === "long") {
        await this.drift.sellSpot(signal.asset, signal.spotSize);
      } else {
        await this.drift.buySpot(signal.asset, signal.spotSize);
      }
    }

    this.state.deployedCapital = Decimal.max(
      new Decimal(0),
      this.state.deployedCapital.sub(signal.spotSize)
    );
    this.state.idleCapital = this.state.idleCapital.add(signal.spotSize);
  }

  /**
   * Track lending yield earned on spot deposits via Drift Data API.
   * Spot assets deposited on Drift earn lending APY automatically.
   */
  private async trackLendingYield(): Promise<void> {
    if (this.state.positions.length === 0) return;

    try {
      for (const asset of config.targetAssets) {
        const spotPos = this.state.positions.find(
          (p) => p.asset === asset && p.venue === "drift" && p.side === "long"
        );
        if (!spotPos) continue;

        // Fetch current deposit rate from Data API
        const depositRates = await this.dataApi.getDepositRateHistory(asset, 1);
        if (depositRates.length === 0) continue;

        const annualRate = depositRates[0].rate;
        // Convert to per-cycle rate (8h cycle = 8/8760 of a year)
        const cycleHours = config.rebalanceIntervalMs / 3600000;
        const cycleRate = annualRate * (cycleHours / 8760);
        const lendingIncome = spotPos.notionalValue.mul(cycleRate);

        if (lendingIncome.gt(0)) {
          this.totalLendingCollected =
            this.totalLendingCollected.add(lendingIncome);
          logger.info(`${asset} lending yield: $${lendingIncome.toFixed(6)}`, {
            annualRate: `${(annualRate * 100).toFixed(2)}%`,
            notional: spotPos.notionalValue.toFixed(2),
          });
        }
      }
    } catch (err) {
      // Non-critical — lending tracking is supplementary
      logger.warn("Could not track lending yield", { error: err });
    }
  }

  async refreshState(): Promise<void> {
    const driftPositions = await this.drift.getPositions();
    const binancePositions =
      this.binance && config.strategyMode === "cross-venue"
        ? await this.binance.getPositions()
        : [];

    this.state.positions = [...driftPositions, ...binancePositions];

    // Calculate total PnL
    this.state.totalPnl = this.state.positions.reduce(
      (sum, p) => sum.add(p.unrealizedPnl),
      new Decimal(0)
    );

    // Update health ratio from Drift
    this.state.healthRatio = await this.drift.getHealthRatio();

    logger.info("State refreshed", {
      positions: this.state.positions.length,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
    });
  }

  async emergencyUnwind(): Promise<void> {
    logger.error("EMERGENCY: Unwinding all positions");

    for (const asset of config.targetAssets) {
      try {
        // Close Binance perps if in cross-venue mode
        if (this.binance && config.strategyMode === "cross-venue") {
          await this.binance.closePerp(asset);
        }

        // Close Drift positions — use atomic exit if executor available
        if (this.executor) {
          await this.executor.atomicDeltaNeutralExit(asset);
        } else {
          await this.drift.closePerp(asset);
        }
      } catch (err) {
        logger.error(`Failed to close ${asset} positions`, { error: err });
      }
    }

    this.state.deployedCapital = new Decimal(0);
    this.state.idleCapital = this.state.totalCapital.add(this.state.totalPnl);
  }

  async reducePositions(): Promise<void> {
    logger.warn("Reducing all positions by 50%");
    // With small hackathon capital, full unwind is the safest approach
    await this.emergencyUnwind();
  }

  getState(): StrategyState {
    return { ...this.state };
  }

  detectRegime(fundingRates: FundingRate[]): MarketRegime {
    if (fundingRates.length === 0) return "neutral";

    const avgRate = fundingRates
      .reduce((sum, r) => sum.add(r.annualizedRate), new Decimal(0))
      .div(fundingRates.length);

    const variance = fundingRates
      .reduce(
        (sum, r) => sum.add(r.annualizedRate.sub(avgRate).pow(2)),
        new Decimal(0)
      )
      .div(fundingRates.length);

    const stdDev = variance.sqrt();

    // High variance = volatile
    if (stdDev.gt(new Decimal("0.5"))) return "volatile";
    // Strongly positive funding = bull (longs paying shorts)
    if (avgRate.gt(new Decimal("0.15"))) return "bull";
    // Negative funding = bear
    if (avgRate.lt(new Decimal("-0.05"))) return "bear";
    return "neutral";
  }
}
