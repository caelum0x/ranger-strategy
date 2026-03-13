import Decimal from "decimal.js";
import { DriftManager } from "../drift/client";
import { DriftFundingAnalyzer, FundingAnalysis } from "../drift/funding";
import { DriftExecutor } from "../drift/executor";
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
  private binance: BinanceManager;
  private riskManager: RiskManager;
  private fundingAnalyzer: DriftFundingAnalyzer | null = null;
  private executor: DriftExecutor | null = null;
  private state: StrategyState;
  private lastFundingSnapshot: Decimal = new Decimal(0);
  private startTime: number = Date.now();

  constructor(
    drift: DriftManager,
    binance: BinanceManager,
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

    // 4. Get funding rates from both venues
    const [driftRates, binanceRates] = await Promise.all([
      this.drift.getFundingRates(),
      this.binance.getFundingRates(),
    ]);

    // 4.5. Detect market regime and update state
    const allRates = [...driftRates, ...binanceRates];
    this.state.regime = this.detectRegime(allRates);
    logger.info(`Market regime: ${this.state.regime}`);

    // 5. Generate trade signals
    const signals = this.generateSignals(driftRates, binanceRates);

    // 6. Execute signals
    for (const signal of signals) {
      await this.executeSignal(signal);
    }

    // 7. Track funding collected
    const fundingPnl = this.drift.getUnrealizedFundingPnl();
    const newFunding = fundingPnl.sub(this.lastFundingSnapshot);
    if (newFunding.gt(0)) {
      this.state.totalFundingCollected = this.state.totalFundingCollected.add(newFunding);
    }
    this.lastFundingSnapshot = fundingPnl;

    // 7.1. Settle funding on Drift
    await this.drift.settleFunding();

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
      const returnSoFar = this.state.totalFundingCollected.div(this.state.totalCapital);
      this.state.apyEstimate = returnSoFar.div(elapsedDays).mul(365.25).mul(100);
    }

    logger.info("=== Strategy cycle complete ===", {
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      positions: this.state.positions.length,
      apyEstimate: `${this.state.apyEstimate.toFixed(2)}%`,
      fundingCollected: `$${this.state.totalFundingCollected.toFixed(4)}`,
      regime: this.state.regime,
    });
  }

  generateSignals(
    driftRates: FundingRate[],
    binanceRates: FundingRate[]
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];

    // Use on-chain funding analysis if available, otherwise fall back to API rates
    const onChainAnalyses = this.fundingAnalyzer
      ? this.fundingAnalyzer.analyzeAllAssets()
      : [];

    // Rank assets by combined Binance + Drift on-chain data
    const rankedAssets = config.targetAssets
      .map((asset) => {
        const binanceRate = binanceRates.find((r) => r.asset === asset);
        const driftRate = driftRates.find((r) => r.asset === asset);
        const onChain = onChainAnalyses.find((a) => a.asset === asset);

        // On-chain analysis provides better signals (premium, imbalance, confidence)
        const confidence = onChain
          ? onChain.confidence
          : new Decimal("0.5");

        // Net yield: funding income from Binance short
        const netYield = binanceRate?.annualizedRate || new Decimal(0);

        return {
          asset,
          binanceFunding: binanceRate?.annualizedRate || new Decimal(0),
          driftFunding: driftRate?.annualizedRate || new Decimal(0),
          onChainAnalysis: onChain,
          netYield,
          confidence,
          isAttractive: onChain ? onChain.isAttractive : netYield.gt(0.05),
        };
      })
      .filter((a) => a.isAttractive && a.netYield.gt(new Decimal("0.05")))
      .sort((a, b) => b.netYield.minus(a.netYield).toNumber());

    logger.info("Asset ranking by predicted funding yield", {
      assets: rankedAssets.map((a) => ({
        asset: a.asset,
        binanceFunding: a.binanceFunding.toFixed(4),
        netYield: a.netYield.toFixed(4),
        confidence: a.confidence.toFixed(2),
        onChainAttractive: a.onChainAnalysis?.isAttractive ?? "N/A",
      })),
    });

    // Check existing positions — do we need to close any?
    for (const pos of this.state.positions) {
      const ranked = rankedAssets.find((a) => a.asset === pos.asset);
      if (!ranked) {
        // Asset no longer attractive, close position
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: "binance",
          spotSize: pos.size,
          perpSize: pos.size,
          confidence: new Decimal(1),
          reason: "Funding rate no longer attractive",
          predictedFundingRate: new Decimal(0),
        });
      }
    }

    // Open or increase positions for attractive assets
    for (const ranked of rankedAssets) {
      const existingPos = this.state.positions.find(
        (p) => p.asset === ranked.asset && p.venue === "drift"
      );

      if (!existingPos && this.state.idleCapital.gt(new Decimal(5))) {
        // New position — use on-chain confidence for sizing
        const positionSize = this.riskManager.calculatePositionSize(
          this.state.idleCapital,
          ranked.asset,
          ranked.binanceFunding,
          ranked.confidence
        );

        if (positionSize.gte(new Decimal(5))) {
          const premium = ranked.onChainAnalysis
            ? ` | premium: ${ranked.onChainAnalysis.premium.mul(100).toFixed(3)}%`
            : "";

          signals.push({
            asset: ranked.asset,
            action: "open",
            spotVenue: "drift",
            perpVenue: "binance",
            spotSize: positionSize,
            perpSize: positionSize,
            confidence: ranked.confidence,
            reason: `Positive funding: ${ranked.binanceFunding.toFixed(4)} annualized${premium}`,
            predictedFundingRate: ranked.binanceFunding,
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
        spotSize: signal.spotSize.toFixed(4),
        reason: signal.reason,
      },
    });

    try {
      switch (signal.action) {
        case "open":
          // Buy spot on Drift
          await this.drift.buySpot(signal.asset, signal.spotSize);
          // Short perp on Binance
          await this.binance.shortPerp(signal.asset, signal.perpSize);

          this.state.deployedCapital = this.state.deployedCapital.add(
            signal.spotSize
          );
          this.state.idleCapital = this.state.idleCapital.sub(signal.spotSize);
          break;

        case "close":
          // Close perp on Binance
          await this.binance.closePerp(signal.asset);
          // Sell spot on Drift
          await this.drift.sellSpot(signal.asset, signal.spotSize);
          break;

        case "rebalance":
          // Adjust sizes
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

  async refreshState(): Promise<void> {
    const [driftPositions, binancePositions] = await Promise.all([
      this.drift.getPositions(),
      this.binance.getPositions(),
    ]);

    this.state.positions = [...driftPositions, ...binancePositions];

    // Calculate total PnL
    this.state.totalPnl = this.state.positions.reduce(
      (sum, p) => sum.add(p.unrealizedPnl),
      new Decimal(0)
    );

    // Update health ratio from Drift
    this.state.healthRatio = await this.drift.getHealthRatio();

    // Estimate APY based on funding collected so far
    // (simplified — would use time-weighted calculation in production)

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
        // Close Binance perp first (CEX is faster)
        await this.binance.closePerp(asset);

        // Use atomic exit on Drift if executor available (cancel+close in one tx)
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
    // In production, would partially close positions
    // For now, full unwind as safety measure with small capital
    await this.emergencyUnwind();
  }

  getState(): StrategyState {
    return { ...this.state };
  }

  detectRegime(fundingRates: FundingRate[]): MarketRegime {
    if (fundingRates.length === 0) return "neutral";

    const avgRate = fundingRates.reduce(
      (sum, r) => sum.add(r.annualizedRate),
      new Decimal(0)
    ).div(fundingRates.length);

    const variance = fundingRates.reduce(
      (sum, r) => sum.add(r.annualizedRate.sub(avgRate).pow(2)),
      new Decimal(0)
    ).div(fundingRates.length);

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
