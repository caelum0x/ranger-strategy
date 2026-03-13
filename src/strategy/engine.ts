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
import { withRetry } from "../utils/retry";
import { FundingPredictor } from "./predictor";
import { OracleGuard } from "../risk/oracle-guard";

export class StrategyEngine {
  private drift: DriftManager;
  private binance: BinanceManager | null;
  private riskManager: RiskManager;
  private fundingAnalyzer: DriftFundingAnalyzer | null = null;
  private executor: DriftExecutor | null = null;
  private dataApi: DriftDataAPI = new DriftDataAPI();
  private state: StrategyState;
  private predictor: FundingPredictor = new FundingPredictor();
  private oracleGuard: OracleGuard = new OracleGuard();
  private latestPredictions: import("./predictor").FundingPrediction[] = [];
  private lastFundingSnapshot: Decimal = new Decimal(0);
  private startTime: number = Date.now();
  private totalLendingCollected: Decimal = new Decimal(0);
  /** Track last direction flip time per asset to prevent rapid flipping */
  private lastFlipTime: Map<string, number> = new Map();
  /** Minimum time between direction flips per asset (24 hours) */
  private readonly MIN_FLIP_INTERVAL_MS = 24 * 3600 * 1000;

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
      totalLendingCollected: new Decimal(0),
      totalTradingCosts: new Decimal(0),
      currentDrawdown: new Decimal(0),
      maxDrawdownHit: new Decimal(0),
      healthRatio: new Decimal(999),
      apyEstimate: new Decimal(0),
      lastRebalance: 0,
      regime: "neutral",
      cycleCount: 0,
      directionFlips: 0,
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

    // 4.6. Feed data to AI predictor for future rate forecasting
    this.predictor.update(driftRates);
    if (binanceRates.length > 0) this.predictor.update(binanceRates);

    this.latestPredictions = this.predictor.predictAll(config.targetAssets);
    const predictions = this.latestPredictions;
    if (predictions.length > 0) {
      logger.info("AI funding predictions", {
        predictions: predictions.map((p) => ({
          asset: p.asset,
          predicted: `${p.predictedRate.mul(100).toFixed(2)}%`,
          confidence: `${p.confidence.mul(100).toFixed(0)}%`,
          direction: p.direction,
          strength: p.signalStrength,
        })),
      });
    }

    // 4.7. Validate we have recent funding data (stale data = bad signals)
    const staleThreshold = 3600 * 1000; // 1 hour
    const staleAssets = driftRates.filter(
      (r) => Date.now() - r.timestamp > staleThreshold
    );
    if (staleAssets.length > 0 && driftRates.length > 0) {
      logger.warn("Stale funding rate data detected", {
        staleAssets: staleAssets.map((r) => r.asset),
        ageMs: staleAssets.map((r) => Date.now() - r.timestamp),
      });
    }

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

    // 9. Update last rebalance timestamp, cycle count, and estimate APY
    this.state.lastRebalance = Date.now();
    this.state.cycleCount++;
    this.state.totalLendingCollected = this.totalLendingCollected;

    const elapsedMs = Date.now() - this.startTime;
    const elapsedDays = elapsedMs / (86400 * 1000);
    if (elapsedDays > 0 && this.state.totalCapital.gt(0)) {
      const totalYield = this.state.totalFundingCollected
        .add(this.totalLendingCollected)
        .sub(this.state.totalTradingCosts);
      const returnSoFar = totalYield.div(this.state.totalCapital);
      this.state.apyEstimate = returnSoFar
        .div(elapsedDays)
        .mul(365.25)
        .mul(100);
    }

    // 10. Auto-compound: reinvest yield into idle capital
    this.autoCompound();

    logger.info("=== Strategy cycle complete ===", {
      mode: config.strategyMode,
      cycle: this.state.cycleCount,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      positions: this.state.positions.length,
      apyEstimate: `${this.state.apyEstimate.toFixed(2)}%`,
      fundingCollected: `$${this.state.totalFundingCollected.toFixed(4)}`,
      lendingCollected: `$${this.totalLendingCollected.toFixed(4)}`,
      tradingCosts: `$${this.state.totalTradingCosts.toFixed(4)}`,
      directionFlips: this.state.directionFlips,
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
    // For negative funding (short spot), we check that funding income > borrow cost
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

        // Use AI predictor confidence when available, falling back to on-chain analysis
        const prediction = this.latestPredictions.find((p) => p.asset === asset);
        const confidence = prediction
          ? prediction.confidence
          : onChain
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
        continue;
      }

      // Rebalance if funding direction has flipped
      // e.g., we're short perp but funding went negative → should be long perp now
      const currentPerpSide = pos.side === "long" ? "short" : "long"; // infer perp side from spot side
      if (currentPerpSide !== ranked.perpSide) {
        // Circuit breaker: prevent rapid flipping (min 24h between flips per asset)
        const lastFlip = this.lastFlipTime.get(pos.asset) || 0;
        const timeSinceFlip = Date.now() - lastFlip;
        if (timeSinceFlip < this.MIN_FLIP_INTERVAL_MS) {
          logger.info(
            `${pos.asset} direction flip suppressed — last flip ${(timeSinceFlip / 3600000).toFixed(1)}h ago (min 24h)`
          );
          continue;
        }

        logger.info(
          `${pos.asset} funding direction flipped: ${currentPerpSide} → ${ranked.perpSide}`
        );
        this.lastFlipTime.set(pos.asset, Date.now());
        signals.push({
          asset: pos.asset,
          action: "rebalance",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: ranked.spotSide,
          perpSide: ranked.perpSide,
          spotSize: pos.notionalValue,
          perpSize: pos.notionalValue,
          confidence: ranked.confidence,
          reason: `Direction flip: ${currentPerpSide} → ${ranked.perpSide} perp (${ranked.primaryRate.toFixed(4)} APY)`,
          predictedFundingRate: ranked.primaryRate,
        });
      }
    }

    // Open positions for attractive assets
    for (const ranked of rankedAssets) {
      const existingPos = this.state.positions.find(
        (p) => p.asset === ranked.asset && p.venue === "drift"
      );

      if (!existingPos && this.state.idleCapital.gt(new Decimal(5))) {
        // Regime-aware sizing: increase allocation in favorable regimes
        const regimeMultiplier = this.getRegimeSizeMultiplier(
          this.state.regime,
          ranked.perpSide
        );

        const baseSize = this.riskManager.calculatePositionSize(
          this.state.idleCapital,
          ranked.asset,
          ranked.absYield,
          ranked.confidence
        );
        const positionSize = baseSize.mul(regimeMultiplier);

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
          await withRetry(
            () => this.executeOpen(signal),
            `open ${signal.asset}`,
            2
          );
          break;

        case "close":
          await withRetry(
            () => this.executeClose(signal),
            `close ${signal.asset}`,
            2
          );
          break;

        case "rebalance":
          // Close first, then re-open with new direction
          await withRetry(
            () => this.executeClose(signal),
            `rebalance-close ${signal.asset}`,
            2
          );
          await withRetry(
            () => this.executeOpen(signal),
            `rebalance-open ${signal.asset}`,
            2
          );
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

  /**
   * Estimate round-trip trading cost for a given position size.
   * Drift fee tiers: Taker 0.10%, Maker 0.02%
   * Our slippage-protected limit orders are mostly maker fills (~70%)
   */
  private estimateTradingCost(notionalSize: Decimal): Decimal {
    const makerRate = new Decimal("0.0002"); // 0.02%
    const takerRate = new Decimal("0.0010"); // 0.10%
    const blendedRate = makerRate.mul("0.7").add(takerRate.mul("0.3")); // ~0.044%
    // Both legs (spot + perp) × entry cost
    return notionalSize.mul(2).mul(blendedRate);
  }

  private async executeOpen(signal: TradeSignal): Promise<void> {
    // Track estimated trading costs
    const cost = this.estimateTradingCost(signal.spotSize);
    this.state.totalTradingCosts = this.state.totalTradingCosts.add(cost);

    // Use atomic entry via executor when available (slippage-protected)
    if (this.executor && signal.perpVenue === "drift") {
      // Atomic cancel + delta-neutral entry in single tx (bi-directional)
      await this.executor.atomicCancelAndEnterDeltaNeutral(
        signal.asset,
        signal.spotSize,
        signal.perpSide
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
          await this.binance.longPerp(signal.asset, signal.perpSize);
        }
      }
    }

    this.state.deployedCapital = this.state.deployedCapital.add(
      signal.spotSize
    );
    this.state.idleCapital = this.state.idleCapital.sub(signal.spotSize);
  }

  private async executeClose(signal: TradeSignal): Promise<void> {
    // Track exit costs
    const cost = this.estimateTradingCost(signal.spotSize);
    this.state.totalTradingCosts = this.state.totalTradingCosts.add(cost);

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
   * Track lending yield earned on spot deposits and borrow costs on short spot.
   *
   * Long spot on Drift earns lending APY automatically.
   * Short spot (borrowed) incurs borrow costs that reduce net yield.
   */
  private async trackLendingYield(): Promise<void> {
    if (this.state.positions.length === 0) return;

    try {
      for (const asset of config.targetAssets) {
        const cycleHours = config.rebalanceIntervalMs / 3600000;

        // Long spot → earns lending yield
        const longSpot = this.state.positions.find(
          (p) => p.asset === asset && p.venue === "drift" && p.side === "long"
        );
        if (longSpot) {
          const depositRates = await this.dataApi.getDepositRateHistory(asset, 1);
          if (depositRates.length > 0) {
            const annualRate = depositRates[0].rate;
            const cycleRate = annualRate * (cycleHours / 8760);
            const lendingIncome = longSpot.notionalValue.mul(cycleRate);

            if (lendingIncome.gt(0)) {
              this.totalLendingCollected =
                this.totalLendingCollected.add(lendingIncome);
              logger.info(`${asset} lending yield: $${lendingIncome.toFixed(6)}`, {
                annualRate: `${(annualRate * 100).toFixed(2)}%`,
                notional: longSpot.notionalValue.toFixed(2),
              });
            }
          }
        }

        // Short spot → incurs borrow cost (negative yield)
        const shortSpot = this.state.positions.find(
          (p) => p.asset === asset && p.venue === "drift" && p.side === "short"
        );
        if (shortSpot) {
          const borrowRates = await this.dataApi.getBorrowRateHistory(asset, 1);
          if (borrowRates.length > 0) {
            const annualBorrowRate = borrowRates[0].rate;
            const cycleRate = annualBorrowRate * (cycleHours / 8760);
            const borrowCost = shortSpot.notionalValue.mul(Math.abs(cycleRate));

            if (borrowCost.gt(0)) {
              this.state.totalTradingCosts =
                this.state.totalTradingCosts.add(borrowCost);
              logger.info(`${asset} borrow cost: -$${borrowCost.toFixed(6)}`, {
                annualRate: `${(annualBorrowRate * 100).toFixed(2)}%`,
                notional: shortSpot.notionalValue.toFixed(2),
              });
            }
          }
        }
      }
    } catch (err) {
      // Non-critical — yield tracking is supplementary
      logger.warn("Could not track lending/borrow yields", { error: err });
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
          await withRetry(
            () => this.binance!.closePerp(asset),
            `emergency-close-binance ${asset}`,
            3
          );
        }

        // Close Drift positions — use atomic exit if executor available
        // atomicDeltaNeutralExit handles both legs (perp + spot) in one tx
        if (this.executor) {
          await withRetry(
            () => this.executor!.atomicDeltaNeutralExit(asset),
            `emergency-exit-drift ${asset}`,
            3
          );
        } else {
          // Manual close: perp first, then spot
          await withRetry(
            () => this.drift.closePerp(asset),
            `emergency-close-perp ${asset}`,
            3
          );
          // Close spot leg — determine direction from current positions
          const spotPos = this.state.positions.find(
            (p) => p.asset === asset && p.venue === "drift"
          );
          if (spotPos) {
            if (spotPos.side === "long") {
              await withRetry(
                () => this.drift.sellSpot(asset, spotPos.notionalValue),
                `emergency-sell-spot ${asset}`,
                3
              );
            } else {
              await withRetry(
                () => this.drift.buySpot(asset, spotPos.notionalValue),
                `emergency-buy-spot ${asset}`,
                3
              );
            }
          }
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

  /**
   * Get the predictor's history for state persistence.
   */
  getPredictorHistory(): Map<string, Decimal[]> {
    return this.predictor.getHistory();
  }

  /**
   * Restore predictor state from saved data.
   */
  restorePredictorHistory(saved: Map<string, Decimal[]>): void {
    this.predictor.restoreHistory(saved);
  }

  /**
   * Restore cumulative state fields from a previous run (crash recovery).
   */
  restoreState(partial: Partial<StrategyState>): void {
    if (partial.totalFundingCollected)
      this.state.totalFundingCollected = partial.totalFundingCollected;
    if (partial.totalLendingCollected) {
      this.state.totalLendingCollected = partial.totalLendingCollected;
      this.totalLendingCollected = partial.totalLendingCollected;
    }
    if (partial.totalTradingCosts)
      this.state.totalTradingCosts = partial.totalTradingCosts;
    if (partial.cycleCount !== undefined)
      this.state.cycleCount = partial.cycleCount;
    if (partial.directionFlips !== undefined)
      this.state.directionFlips = partial.directionFlips;
    logger.info("Strategy state restored from saved data", {
      cycle: this.state.cycleCount,
      funding: this.state.totalFundingCollected.toFixed(4),
    });
  }

  /**
   * Auto-compound: reinvest collected funding/lending yield into idle capital.
   * Called at the end of each cycle to grow position sizes over time.
   */
  autoCompound(): { compounded: Decimal; newIdle: Decimal } {
    // Net yield available to reinvest
    const netYield = this.state.totalFundingCollected
      .add(this.state.totalLendingCollected)
      .sub(this.state.totalTradingCosts);

    // Only compound if net yield is positive and meaningful ($0.01+)
    const minCompoundThreshold = new Decimal("0.01");
    if (netYield.lte(minCompoundThreshold)) {
      return { compounded: new Decimal(0), newIdle: this.state.idleCapital };
    }

    // The yield already manifests in PnL, but we explicitly track
    // compounding to adjust available capital for position sizing.
    // idleCapital includes unrealized PnL, so we just need to log it.
    const totalAvailable = this.state.totalCapital.add(this.state.totalPnl);
    const effectiveIdle = totalAvailable.sub(this.state.deployedCapital);

    if (effectiveIdle.gt(this.state.idleCapital)) {
      const compoundedAmount = effectiveIdle.sub(this.state.idleCapital);
      this.state.idleCapital = effectiveIdle;
      logger.info(`Auto-compound: +$${compoundedAmount.toFixed(4)} reinvested`, {
        netYield: netYield.toFixed(4),
        newIdle: this.state.idleCapital.toFixed(2),
      });
      return { compounded: compoundedAmount, newIdle: this.state.idleCapital };
    }

    return { compounded: new Decimal(0), newIdle: this.state.idleCapital };
  }

  /**
   * Regime-aware position sizing multiplier.
   * Bull regime → shorts collect more funding → increase short perp allocation
   * Bear regime → longs collect more funding → increase long perp allocation
   * Volatile → reduce allocation to limit drawdown risk
   */
  private getRegimeSizeMultiplier(
    regime: MarketRegime,
    perpSide: "short" | "long"
  ): Decimal {
    switch (regime) {
      case "bull":
        // Bull = positive funding = shorts profitable
        return perpSide === "short" ? new Decimal("1.2") : new Decimal("0.8");
      case "bear":
        // Bear = negative funding = longs profitable
        return perpSide === "long" ? new Decimal("1.2") : new Decimal("0.8");
      case "volatile":
        // Reduce exposure in volatile markets
        return new Decimal("0.7");
      case "neutral":
      default:
        return new Decimal("1.0");
    }
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
