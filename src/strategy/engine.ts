import Decimal from "decimal.js";
import { DriftManager } from "../drift/client";
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
  private state: StrategyState;

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

    // 5. Generate trade signals
    const signals = this.generateSignals(driftRates, binanceRates);

    // 6. Execute signals
    for (const signal of signals) {
      await this.executeSignal(signal);
    }

    // 7. Settle funding on Drift
    await this.drift.settleFunding();

    // 8. Update state again
    await this.refreshState();

    logger.info("=== Strategy cycle complete ===", {
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      positions: this.state.positions.length,
      apyEstimate: this.state.apyEstimate.toFixed(2),
    });
  }

  generateSignals(
    driftRates: FundingRate[],
    binanceRates: FundingRate[]
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];

    // Rank assets by Binance funding rate (where we short)
    const rankedAssets = config.targetAssets
      .map((asset) => {
        const binanceRate = binanceRates.find((r) => r.asset === asset);
        const driftRate = driftRates.find((r) => r.asset === asset);
        return {
          asset,
          binanceFunding: binanceRate?.annualizedRate || new Decimal(0),
          driftFunding: driftRate?.annualizedRate || new Decimal(0),
          // Net yield = funding income from short - opportunity cost
          netYield: (binanceRate?.annualizedRate || new Decimal(0)),
        };
      })
      .filter((a) => a.netYield.gt(new Decimal("0.05"))) // Only assets with >5% annualized funding
      .sort((a, b) => b.netYield.minus(a.netYield).toNumber());

    logger.info("Asset ranking by predicted funding yield", {
      assets: rankedAssets.map((a) => ({
        asset: a.asset,
        binanceFunding: a.binanceFunding.toFixed(4),
        netYield: a.netYield.toFixed(4),
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
        // New position
        const positionSize = this.riskManager.calculatePositionSize(
          this.state.idleCapital,
          ranked.asset,
          ranked.binanceFunding,
          new Decimal("0.8") // confidence
        );

        if (positionSize.gte(new Decimal(5))) {
          signals.push({
            asset: ranked.asset,
            action: "open",
            spotVenue: "drift",
            perpVenue: "binance",
            spotSize: positionSize,
            perpSize: positionSize,
            confidence: new Decimal("0.8"),
            reason: `Positive funding: ${ranked.binanceFunding.toFixed(4)} annualized`,
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
        await this.binance.closePerp(asset);
        await this.drift.closePerp(asset);
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
