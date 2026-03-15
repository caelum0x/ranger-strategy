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
  IndexerDecisionSummary,
  IndexerSnapshotSummary,
  MarketRegime,
  Position,
  StrategyState,
  TradeSignal,
} from "./types";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { TradeLogger } from "../utils/trade-logger";
import { VaultPerformanceTracker } from "../vault/performance";
import { FundingPredictor } from "./predictor";
import { OracleGuard } from "../risk/oracle-guard";
import { StrategyAdvisor, LLMStrategyAdvice } from "../ai/strategy-advisor";
import { selectBestLST, calculateLSTYieldBoost, supportsLST } from "./lst";

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
  private advisor: StrategyAdvisor | null = null;
  private lastLLMAdvice: LLMStrategyAdvice | null = null;
  private tradeLogger: TradeLogger = new TradeLogger();
  private vaultPerf: VaultPerformanceTracker = new VaultPerformanceTracker();
  /** Pending vault withdrawals — reserve this amount as idle liquidity */
  private pendingWithdrawals: Decimal = new Decimal(0);
  private latestPredictions: import("./predictor").FundingPrediction[] = [];
  private lastFundingSnapshot: Decimal = new Decimal(0);
  private startTime: number = Date.now();
  private totalLendingCollected: Decimal = new Decimal(0);
  /** Track last direction flip time per asset to prevent rapid flipping */
  private lastFlipTime: Map<string, number> = new Map();
  /** Tracks which assets currently have LST-based positions (JitoSOL/mSOL/bSOL as collateral) */
  private lstPositions: Set<string> = new Set();
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
      strategyProfile: config.strategyProfile,
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

  /**
   * Attach the LLM strategy advisor for AI-powered decision-making.
   */
  setAdvisor(advisor: StrategyAdvisor): void {
    this.advisor = advisor;
  }

  setIndexerContext(context: {
    snapshot?: IndexerSnapshotSummary;
    decision?: IndexerDecisionSummary;
  }): void {
    this.state.indexerSnapshot = context.snapshot;
    this.state.indexerDecision = context.decision;
  }

  /**
   * Get natural language reasoning from the last LLM analysis.
   */
  getLastReasoning(): string | null {
    return this.advisor?.getLastReasoning() || null;
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

    // 4.5. Detect market regime — LLM-first, fallback to heuristic
    const allRates = [...driftRates, ...binanceRates];

    // 4.6. LLM Strategy Advisor (replaces EMA predictor when available)
    if (this.advisor) {
      try {
        const onChainAnalyses = this.fundingAnalyzer
          ? this.fundingAnalyzer.analyzeAllAssets()
          : [];

        this.lastLLMAdvice = await this.advisor.analyze({
          fundingRates: driftRates,
          positions: this.state.positions,
          state: this.state,
          onChainAnalyses,
          targetAssets: config.targetAssets,
        });

        // Use LLM regime classification
        const prevRegime = this.state.regime;
        this.state.regime = this.lastLLMAdvice.regime;
        logger.info(`LLM regime: ${this.state.regime} — ${this.lastLLMAdvice.regimeReasoning}`);

        if (prevRegime !== this.state.regime) {
          this.tradeLogger.logRegimeChange(prevRegime, this.state.regime, this.lastLLMAdvice.regimeReasoning);
        }
        this.tradeLogger.logLLMAdvice(
          this.state.regime,
          this.lastLLMAdvice.decisions.map((d) => ({
            asset: d.asset,
            action: d.action,
            perpSide: d.perpSide,
            allocation: d.allocationFraction,
          }))
        );

        // Convert LLM predictions to FundingPrediction interface
        this.latestPredictions = this.advisor.toFundingPredictions(this.lastLLMAdvice);

        // Log LLM reasoning
        const reasoning = this.advisor.getLastReasoning();
        if (reasoning) {
          logger.info("LLM trade reasoning:\n" + reasoning);
        }
      } catch (err: any) {
        logger.warn(`LLM advisor failed, falling back to EMA predictor: ${err.message}`);
        this.state.regime = this.detectRegime(allRates);
        this.predictor.update(driftRates);
        if (binanceRates.length > 0) this.predictor.update(binanceRates);
        this.latestPredictions = this.predictor.predictAll(config.targetAssets);
      }
    } else {
      // No LLM advisor — use heuristic regime detection + EMA predictor
      this.state.regime = this.detectRegime(allRates);
      this.predictor.update(driftRates);
      if (binanceRates.length > 0) this.predictor.update(binanceRates);
      this.latestPredictions = this.predictor.predictAll(config.targetAssets);
    }

    logger.info(`Market regime: ${this.state.regime}`);

    const predictions = this.latestPredictions;
    if (predictions.length > 0) {
      logger.info("Funding predictions", {
        source: this.advisor ? "LLM" : "EMA",
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

    // 4.8. Pre-fetch borrow rates for cost-aware signal generation
    const borrowRates = new Map<string, number>();
    for (const asset of config.targetAssets) {
      try {
        const rates = await this.dataApi.getBorrowRateHistory(asset, 1);
        if (rates.length > 0) borrowRates.set(asset, rates[0].rate);
      } catch {
        // Non-critical — will skip borrow cost check for this asset
      }
    }

    // 4.9. Per-position management: profit-taking and stop-loss
    const positionSignals = this.manageExistingPositions(driftRates);

    // 5. Generate trade signals (new entries + rebalances)
    this.tradeLogger.setCycle(this.state.cycleCount);
    const signals = [...positionSignals, ...this.generateSignals(driftRates, binanceRates, borrowRates)];

    // Log all generated signals
    for (const signal of signals) {
      this.tradeLogger.logSignal(signal);
    }

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
      for (const signal of signals) {
        this.tradeLogger.logSkipped(signal.asset, "Near funding settlement");
      }
    } else {
      // 6. Execute signals (only when not near settlement)
      for (const signal of signals) {
        await this.executeSignal(signal);
      }
    }

    // 6.5. Log open orders (for debugging fill status)
    if (this.executor) {
      const openOrders = this.executor.getOpenOrders();
      if (openOrders.length > 0) {
        logger.info(`Open orders pending fill: ${openOrders.length}`, {
          orders: openOrders.map((o) => `${o.direction} ${o.asset} ${o.marketType} #${o.orderId}`),
        });
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
    // Only estimate APY after at least 1 hour of running to avoid wild numbers
    if (elapsedDays > (1 / 24) && this.state.totalCapital.gt(0)) {
      const totalYield = this.state.totalFundingCollected
        .add(this.totalLendingCollected)
        .sub(this.state.totalTradingCosts);
      const returnSoFar = totalYield.div(this.state.totalCapital);
      this.state.apyEstimate = returnSoFar
        .div(elapsedDays)
        .mul(365.25)
        .mul(100);
    } else {
      // Too early to estimate — show 0 instead of wild extrapolations
      this.state.apyEstimate = new Decimal(0);
    }

    // 10. Auto-compound: reinvest yield into idle capital
    this.autoCompound();

    // Log cycle completion to trade log
    this.tradeLogger.logCycleComplete({
      cycle: this.state.cycleCount,
      regime: this.state.regime,
      positions: this.state.positions.length,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      fundingCollected: this.state.totalFundingCollected.toFixed(4),
      lendingCollected: this.totalLendingCollected.toFixed(4),
      tradingCosts: this.state.totalTradingCosts.toFixed(4),
      apyEstimate: `${this.state.apyEstimate.toFixed(2)}%`,
      directionFlips: this.state.directionFlips,
    });

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

  /**
   * Manage existing positions: profit-taking and stop-loss.
   *
   * For each open position, check:
   * 1. Stop-loss: if PnL is worse than -2% of notional, close (capital preservation)
   * 2. Profit-taking: if PnL > expected funding income for next 24h, trim risk
   * 3. Zombie cleanup: close positions with negligible notional (<$1)
   */
  private manageExistingPositions(driftRates: FundingRate[]): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const isDriftOnly = config.strategyMode === "drift-only";

    for (const pos of this.state.positions) {
      const pnlPct = pos.notionalValue.gt(0)
        ? pos.unrealizedPnl.div(pos.notionalValue).mul(100)
        : new Decimal(0);

      // 1. Stop-loss: close if PnL worse than -2% of notional
      // With $20 capital and 2x leverage, -2% notional = -$0.40 loss — significant
      if (pnlPct.lt(-2)) {
        logger.warn(
          `${pos.asset} stop-loss triggered: PnL ${pnlPct.toFixed(2)}% (${pos.unrealizedPnl.toFixed(4)} USDC)`
        );
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: pos.side,
          perpSide: pos.side === "long" ? "short" : "long",
          spotSize: pos.notionalValue,
          perpSize: pos.notionalValue,
          confidence: new Decimal(1),
          reason: `Stop-loss: PnL ${pnlPct.toFixed(2)}% exceeds -2% threshold`,
          predictedFundingRate: new Decimal(0),
        });
        this.tradeLogger.logClose(pos.asset, `Stop-loss at ${pnlPct.toFixed(2)}%`);
        continue;
      }

      // 2. Profit-taking: if PnL > expected 24h funding income, lock in profits
      // Expected income = notional * |funding rate| * (24/8760)
      const rate = driftRates.find((r) => r.asset === pos.asset);
      if (rate && pos.unrealizedPnl.gt(0)) {
        const expected24hIncome = pos.notionalValue
          .mul(rate.annualizedRate.abs())
          .mul(24)
          .div(8760);

        // If unrealized PnL is >3x expected 24h income, take profits
        if (expected24hIncome.gt(0) && pos.unrealizedPnl.gt(expected24hIncome.mul(3))) {
          logger.info(
            `${pos.asset} profit-take: PnL $${pos.unrealizedPnl.toFixed(4)} > 3x expected 24h ($${expected24hIncome.toFixed(4)})`
          );
          signals.push({
            asset: pos.asset,
            action: "close",
            spotVenue: "drift",
            perpVenue: isDriftOnly ? "drift" : "binance",
            spotSide: pos.side,
            perpSide: pos.side === "long" ? "short" : "long",
            spotSize: pos.notionalValue,
            perpSize: pos.notionalValue,
            confidence: new Decimal("0.9"),
            reason: `Profit-take: PnL $${pos.unrealizedPnl.toFixed(4)} exceeds 3x expected 24h funding`,
            predictedFundingRate: rate.annualizedRate,
          });
          this.tradeLogger.logClose(pos.asset, `Profit-take at $${pos.unrealizedPnl.toFixed(4)}`);
          continue;
        }
      }

      // 3. Zombie cleanup: close positions with negligible notional
      if (pos.notionalValue.lt(1)) {
        logger.info(`${pos.asset} zombie position closed: notional $${pos.notionalValue.toFixed(4)}`);
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: pos.side,
          perpSide: pos.side === "long" ? "short" : "long",
          spotSize: pos.notionalValue,
          perpSize: pos.notionalValue,
          confidence: new Decimal(1),
          reason: "Zombie cleanup: notional below $1",
          predictedFundingRate: new Decimal(0),
        });
        continue;
      }
    }

    // 4. Concentration check: if any single asset uses >40% of margin, trim it
    if (this.state.positions.length > 2) {
      const overconcentrated = this.riskManager.getOverconcentratedPositions(
        this.state.positions,
        new Decimal("0.4")
      );
      for (const oc of overconcentrated) {
        // Don't double-close if already signaled above
        if (signals.some(s => s.asset === oc.asset)) continue;

        const worst = this.riskManager.getWorstPosition(
          this.state.positions.filter(p => p.asset === oc.asset)
        );
        if (worst) {
          logger.warn(
            `${oc.asset} overconcentrated at ${oc.concentration.mul(100).toFixed(1)}% — trimming`
          );
          signals.push({
            asset: oc.asset,
            action: "decrease",
            spotVenue: "drift",
            perpVenue: config.strategyMode === "drift-only" ? "drift" : "binance",
            spotSide: worst.side,
            perpSide: worst.side === "long" ? "short" : "long",
            spotSize: worst.notionalValue.mul("0.3"), // trim 30%
            perpSize: worst.notionalValue.mul("0.3"),
            confidence: new Decimal("0.8"),
            reason: `Concentration trim: ${oc.asset} at ${oc.concentration.mul(100).toFixed(1)}% of notional`,
            predictedFundingRate: new Decimal(0),
          });
          this.tradeLogger.logClose(
            oc.asset,
            `Concentration trim: ${oc.concentration.mul(100).toFixed(1)}%`
          );
        }
      }
    }

    return signals;
  }

  generateSignals(
    driftRates: FundingRate[],
    binanceRates: FundingRate[],
    borrowRates: Map<string, number> = new Map()
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const isDriftOnly = config.strategyMode === "drift-only";
    const isDriftBear = this.isDriftBearMode();
    const indexerDecision = this.state.indexerDecision;

    // Use on-chain funding analysis if available
    const onChainAnalyses = this.fundingAnalyzer
      ? this.fundingAnalyzer.analyzeAllAssets()
      : [];

    // Rank assets by funding yield — bi-directional (positive OR negative)
    // For negative funding (short spot), check that funding income > borrow cost
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

        // Borrow cost check: when funding is negative (short spot), borrow cost
        // eats into funding income. Skip if net yield is below threshold.
        const borrowRate = borrowRates.get(asset) || 0;
        let netYield = absYield;
        if (perpSide === "long" && borrowRate > 0) {
          // Short spot incurs borrow cost
          netYield = absYield.sub(new Decimal(borrowRate));
          if (netYield.lt(config.minFundingAPY)) {
            logger.info(
              `${asset}: funding ${absYield.mul(100).toFixed(2)}% minus borrow ${(borrowRate * 100).toFixed(2)}% = net ${netYield.mul(100).toFixed(2)}% — below threshold`
            );
          }
        }

        return {
          asset,
          primaryRate,
          absYield,
          netYield,
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
      // Filter by net yield (after borrow costs) instead of just gross yield
      .filter((a) => a.isAttractive && a.netYield.gt(config.minFundingAPY))
      .sort((a, b) => {
        // Sort by momentum-adjusted yield: absYield * (1 + momentum bonus)
        const aScore = a.absYield.mul(new Decimal(1).add(a.momentumBonus.mul("0.3")));
        const bScore = b.absYield.mul(new Decimal(1).add(b.momentumBonus.mul("0.3")));
        return bScore.minus(aScore).toNumber();
      });

    const candidateAssets =
      isDriftBear && config.driftBearTopAssetOnly
        ? rankedAssets.slice(0, 1)
        : rankedAssets;

    logger.info("Asset ranking (bi-directional funding)", {
      mode: config.strategyMode,
      profile: this.state.strategyProfile,
      indexerAction: indexerDecision?.action,
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
      const ranked = candidateAssets.find((a) => a.asset === pos.asset);

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
    // As vault manager: reserve liquidity for pending withdrawals
    const { deployable: deployableCapital } = this.vaultPerf.getDeployableCapital(
      this.state.totalCapital,
      this.state.idleCapital,
      this.pendingWithdrawals
    );

    const allowNewEntries = !(
      indexerDecision &&
      indexerDecision.action === "hold" &&
      indexerDecision.confidence.gte("0.6")
    );

    for (const ranked of candidateAssets) {
      const existingPos = this.state.positions.find(
        (p) => p.asset === ranked.asset && p.venue === "drift"
      );

      if (!existingPos && deployableCapital.gt(new Decimal(5)) && allowNewEntries) {
        // Check LLM trade decision if available
        const llmDecision = this.lastLLMAdvice?.decisions.find(
          (d) => d.asset === ranked.asset
        );

        // If LLM says skip or close, respect that
        if (llmDecision && (llmDecision.action === "skip" || llmDecision.action === "close")) {
          logger.info(`LLM says ${llmDecision.action} ${ranked.asset}: ${llmDecision.reasoning}`);
          continue;
        }

        // Regime-aware sizing: increase allocation in favorable regimes
        const regimeMultiplier = this.getRegimeSizeMultiplier(
          this.state.regime,
          ranked.perpSide
        );

        let positionBudget = deployableCapital;
        if (isDriftBear) {
          positionBudget = deployableCapital.mul(
            indexerDecision?.targetAllocation || config.driftBearNeutralAllocation
          );
        }

        if (indexerDecision?.action === "reduce-risk") {
          positionBudget = positionBudget.mul("0.5");
        }

        let positionSize: Decimal;
        if (llmDecision && llmDecision.allocationFraction > 0) {
          // LLM-driven position sizing (respects withdrawal-reserved liquidity)
          positionSize = positionBudget
            .mul(llmDecision.allocationFraction)
            .mul(regimeMultiplier);
          // Override perp side if LLM disagrees
          if (llmDecision.perpSide !== ranked.perpSide) {
            logger.info(
              `LLM overrides ${ranked.asset} direction: ${ranked.perpSide} → ${llmDecision.perpSide}`
            );
            ranked.perpSide = llmDecision.perpSide;
            ranked.spotSide = llmDecision.perpSide === "short" ? "long" : "short";
          }
        } else {
          // Fallback: risk-manager-driven sizing (respects withdrawal-reserved liquidity)
          const baseSize = this.riskManager.calculatePositionSize(
            positionBudget,
            ranked.asset,
            ranked.absYield,
            ranked.confidence
          );
          positionSize = baseSize.mul(regimeMultiplier);
        }

        if (isDriftBear) {
          const hardCap = deployableCapital.mul(
            indexerDecision?.targetAllocation || config.driftBearNeutralAllocation
          );
          positionSize = Decimal.min(positionSize, hardCap);
        }

        // Momentum-scaled sizing: rising momentum → up to 30% larger,
        // falling momentum → up to 20% smaller, flat → no change
        if (ranked.momentum === "rising") {
          const bonus = Decimal.min(ranked.momentumBonus.mul("0.3"), new Decimal("0.3"));
          const momentumScale = new Decimal(1).add(bonus);
          positionSize = positionSize.mul(momentumScale);
        } else if (ranked.momentum === "falling") {
          const penalty = Decimal.min(ranked.momentumBonus.abs().mul("0.2"), new Decimal("0.2"));
          const momentumScale = new Decimal(1).sub(penalty);
          positionSize = positionSize.mul(momentumScale);
        }

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
          this.tradeLogger.logExecution(signal.asset, "open", {
            perpSide: signal.perpSide,
            spotSide: signal.spotSide,
            size: signal.spotSize.toFixed(4),
            reason: signal.reason,
          });
          break;

        case "close":
          await withRetry(
            () => this.executeClose(signal),
            `close ${signal.asset}`,
            2
          );
          this.tradeLogger.logClose(signal.asset, signal.reason);
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
          this.tradeLogger.logDirectionFlip(
            signal.asset,
            signal.spotSide === "long" ? "short" : "long",
            signal.perpSide,
            signal.predictedFundingRate.toFixed(4)
          );
          this.state.directionFlips++;
          break;

        default:
          logger.warn(`Unknown signal action: ${signal.action}`);
      }
    } catch (err: any) {
      this.tradeLogger.logFailure(signal.asset, signal.action, err.message || String(err));
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
      // LST yield stacking: for SOL short-perp entries in drift-only mode,
      // swap USDC → JitoSOL (or best LST) as collateral instead of raw SOL.
      // This adds ~7% staking APY on top of funding rate + lending yield.
      const lst = signal.perpSide === "short" && supportsLST(signal.asset)
        ? selectBestLST(signal.asset)
        : null;

      if (lst) {
        await this.executor.atomicLSTEntry(
          lst.spotIndex,
          signal.asset,
          signal.spotSize
        );
        this.lstPositions.add(signal.asset);

        // Log the LST yield boost for transparency / monitoring
        const boost = calculateLSTYieldBoost(lst, signal.spotSize);
        logger.info(`LST yield boost for ${signal.asset}`, {
          lst: lst.name,
          stakingAPY: `${lst.stakingAPY.mul(100).toFixed(1)}%`,
          estimatedDailyYield: `$${boost.dailyYield.toFixed(4)}`,
          estimatedAnnualYield: `$${boost.annualYield.toFixed(2)}`,
        });
      } else {
        // Standard atomic cancel + delta-neutral entry (bi-directional)
        await this.executor.atomicCancelAndEnterDeltaNeutral(
          signal.asset,
          signal.spotSize,
          signal.perpSide
        );
      }
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
        // If this position was entered via LST stacking, close via LST exit
        // (close perp + swap LST back to USDC in one atomic tx)
        if (this.lstPositions.has(signal.asset)) {
          const lst = selectBestLST(signal.asset);
          if (lst) {
            await this.executor.atomicLSTExit(lst.spotIndex, signal.asset);
            this.lstPositions.delete(signal.asset);
          } else {
            await this.executor.atomicDeltaNeutralExit(signal.asset);
          }
        } else {
          await this.executor.atomicDeltaNeutralExit(signal.asset);
        }
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
    this.tradeLogger.logEmergencyUnwind(
      `Health: ${this.state.healthRatio.toFixed(4)}, Drawdown: ${this.state.currentDrawdown.toFixed(2)}%`
    );

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
        // For LST positions, swap LST back to USDC; otherwise standard exit
        if (this.executor) {
          if (this.lstPositions.has(asset)) {
            const lst = selectBestLST(asset);
            if (lst) {
              await withRetry(
                () => this.executor!.atomicLSTExit(lst.spotIndex, asset),
                `emergency-exit-lst ${asset}`,
                3
              );
              this.lstPositions.delete(asset);
            } else {
              await withRetry(
                () => this.executor!.atomicDeltaNeutralExit(asset),
                `emergency-exit-drift ${asset}`,
                3
              );
            }
          } else {
            await withRetry(
              () => this.executor!.atomicDeltaNeutralExit(asset),
              `emergency-exit-drift ${asset}`,
              3
            );
          }
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
   * Update pending vault withdrawal amount.
   * The engine will reserve this as idle liquidity, not deploying it.
   */
  setPendingWithdrawals(amount: Decimal): void {
    this.pendingWithdrawals = amount;
  }

  /**
   * Get the agent start time (for APY calculation).
   */
  getStartTime(): number {
    return this.startTime;
  }

  /**
   * Restore start time from saved state (crash recovery).
   */
  setStartTime(ts: number): void {
    this.startTime = ts;
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

  private isDriftBearMode(): boolean {
    return (this.state.strategyProfile || config.strategyProfile) === "driftbear-neutral-farmer";
  }
}
