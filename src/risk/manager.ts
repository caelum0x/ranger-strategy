import Decimal from "decimal.js";
import { config } from "../config";
import { Position, RiskCheck, StrategyState } from "../strategy/types";
import { logger } from "../utils/logger";

export class RiskManager {
  private maxLeverage: Decimal;
  private healthRatioFloor: Decimal;
  private maxDrawdownPct: Decimal;
  private initialCapital: Decimal;
  private peakEquity: Decimal;
  /** Previous health ratio for spike detection */
  private lastHealthRatio: Decimal = new Decimal(999);
  /** Maximum acceptable health ratio drop per check (>50% drop = spike) */
  private readonly HEALTH_SPIKE_THRESHOLD = new Decimal("0.5");

  constructor(initialCapital: Decimal) {
    this.maxLeverage = config.maxLeverage;
    this.healthRatioFloor = config.healthRatioFloor;
    this.maxDrawdownPct = config.maxDrawdownPct;
    this.initialCapital = initialCapital;
    this.peakEquity = initialCapital;
  }

  checkRisk(state: StrategyState): RiskCheck {
    const violations: string[] = [];

    // Update peak equity (high-water mark for drawdown)
    const currentEquity = state.totalCapital.add(state.totalPnl);
    if (currentEquity.gt(this.peakEquity)) {
      this.peakEquity = currentEquity;
    }

    // Check health ratio
    if (state.healthRatio.lt(this.healthRatioFloor)) {
      violations.push(
        `Health ratio ${state.healthRatio.toFixed(4)} below floor ${this.healthRatioFloor.toFixed(4)}`
      );
    }

    // Health ratio spike detection: sudden large drops indicate rapid deterioration
    if (this.lastHealthRatio.gt(0) && !this.lastHealthRatio.eq(999)) {
      const dropRatio = this.lastHealthRatio.sub(state.healthRatio).div(this.lastHealthRatio);
      if (dropRatio.gt(this.HEALTH_SPIKE_THRESHOLD)) {
        violations.push(
          `Health ratio spike: ${this.lastHealthRatio.toFixed(4)} → ${state.healthRatio.toFixed(4)} ` +
            `(${dropRatio.mul(100).toFixed(1)}% drop)`
        );
        logger.warn("Health ratio spike detected — consider reducing positions", {
          previous: this.lastHealthRatio.toFixed(4),
          current: state.healthRatio.toFixed(4),
          dropPct: `${dropRatio.mul(100).toFixed(1)}%`,
        });
      }
    }
    this.lastHealthRatio = state.healthRatio;

    // Check drawdown from peak equity (not initial capital)
    const drawdown = this.calculateDrawdown(state);
    if (drawdown.gt(this.maxDrawdownPct)) {
      violations.push(
        `Drawdown ${drawdown.toFixed(2)}% exceeds max ${this.maxDrawdownPct.toFixed(2)}%`
      );
    }

    // Check total leverage
    const totalLeverage = this.calculateTotalLeverage(state);
    if (totalLeverage.gt(this.maxLeverage)) {
      violations.push(
        `Leverage ${totalLeverage.toFixed(2)}x exceeds max ${this.maxLeverage.toFixed(2)}x`
      );
    }

    // Check per-asset-pair delta neutrality
    const pairDeltas = this.calculatePerAssetDelta(state.positions);
    for (const [asset, delta] of Object.entries(pairDeltas)) {
      const deltaThreshold = new Decimal("0.05"); // 5% per-pair tolerance
      if (delta.abs().gt(deltaThreshold)) {
        violations.push(
          `${asset} pair delta ${delta.toFixed(4)} exceeds ±${deltaThreshold.toFixed(2)}`
        );
      }
    }

    // Check net portfolio delta
    const netDelta = this.calculateNetDelta(state.positions);
    const portfolioDeltaThreshold = new Decimal("0.05");
    if (netDelta.abs().gt(portfolioDeltaThreshold)) {
      violations.push(
        `Net portfolio delta ${netDelta.toFixed(4)} exceeds threshold ±${portfolioDeltaThreshold.toFixed(2)}`
      );
    }

    if (violations.length > 0) {
      logger.warn("Risk violations detected", { violations });
    }

    return {
      passed: violations.length === 0,
      healthRatio: state.healthRatio,
      drawdown,
      leverage: totalLeverage,
      violations,
    };
  }

  shouldEmergencyUnwind(state: StrategyState): boolean {
    // Critical health ratio — must unwind immediately
    if (state.healthRatio.lt(new Decimal("1.05"))) {
      logger.error("CRITICAL: Health ratio below 1.05, emergency unwind required");
      return true;
    }

    // Drawdown circuit breaker (from peak equity)
    const drawdown = this.calculateDrawdown(state);
    if (drawdown.gt(this.maxDrawdownPct)) {
      logger.error(`CRITICAL: Drawdown ${drawdown.toFixed(2)}% hit circuit breaker`);
      return true;
    }

    return false;
  }

  calculatePositionSize(
    availableCapital: Decimal,
    asset: string,
    predictedFundingRate: Decimal,
    confidence: Decimal
  ): Decimal {
    // Kelly-inspired sizing: size proportional to edge * confidence
    // But capped at max per-asset allocation (33% for 3 assets)
    const maxPerAsset = availableCapital.div(config.targetAssets.length);
    const edgeMultiplier = predictedFundingRate.mul(confidence);
    const baseSize = maxPerAsset.mul(edgeMultiplier.div(new Decimal("0.01"))); // normalize to 1% funding

    // Clamp between min and max
    const minSize = new Decimal("5"); // $5 minimum position
    const maxSize = maxPerAsset;

    let size = Decimal.max(minSize, Decimal.min(baseSize, maxSize));

    // Enforce total leverage bound: new position can't push leverage past max
    // Each delta-neutral pair has 2 legs, so notional = 2 * size
    // But they offset, so effective leverage ~ size / capital
    const leverageCap = this.maxLeverage.mul(availableCapital);
    if (size.gt(leverageCap)) {
      size = leverageCap;
      logger.info(`Position size capped by leverage bound: $${size.toFixed(2)}`);
    }

    logger.info(`Position size for ${asset}: $${size.toFixed(2)}`, {
      availableCapital: availableCapital.toFixed(2),
      predictedFundingRate: predictedFundingRate.toFixed(6),
      confidence: confidence.toFixed(4),
    });

    return size;
  }

  private calculateDrawdown(state: StrategyState): Decimal {
    const currentEquity = state.totalCapital.add(state.totalPnl);
    if (currentEquity.gte(this.peakEquity)) return new Decimal(0);
    return this.peakEquity.sub(currentEquity).div(this.peakEquity).mul(100);
  }

  private calculateTotalLeverage(state: StrategyState): Decimal {
    // Only count perp notional for leverage (spot is collateral)
    const perpNotional = state.positions
      .filter((p) => p.side === "short" || p.side === "long")
      .reduce((sum, p) => sum.add(p.notionalValue), new Decimal(0));
    // Divide by 2 since delta-neutral pairs have matched notional
    const effectiveNotional = perpNotional.div(2);
    if (state.totalCapital.isZero()) return new Decimal(0);
    return effectiveNotional.div(state.totalCapital);
  }

  /**
   * Calculate per-asset-pair delta to ensure each basis trade is neutral.
   * Groups positions by asset and sums signed notional.
   */
  private calculatePerAssetDelta(
    positions: Position[]
  ): Record<string, Decimal> {
    const deltas: Record<string, Decimal> = {};

    for (const p of positions) {
      if (!deltas[p.asset]) deltas[p.asset] = new Decimal(0);
      const signed =
        p.side === "long" ? p.notionalValue : p.notionalValue.neg();
      deltas[p.asset] = deltas[p.asset].add(signed);
    }

    // Normalize by total notional per asset for relative delta
    const totals: Record<string, Decimal> = {};
    for (const p of positions) {
      if (!totals[p.asset]) totals[p.asset] = new Decimal(0);
      totals[p.asset] = totals[p.asset].add(p.notionalValue);
    }

    const relativeDeltas: Record<string, Decimal> = {};
    for (const [asset, delta] of Object.entries(deltas)) {
      const total = totals[asset] || new Decimal(1);
      relativeDeltas[asset] = total.isZero()
        ? new Decimal(0)
        : delta.div(total);
    }

    return relativeDeltas;
  }

  private calculateNetDelta(positions: Position[]): Decimal {
    const totalNotional = positions.reduce(
      (sum, p) => sum.add(p.notionalValue),
      new Decimal(0)
    );
    if (totalNotional.isZero()) return new Decimal(0);

    const signedSum = positions.reduce((delta, p) => {
      const signed =
        p.side === "long" ? p.notionalValue : p.notionalValue.neg();
      return delta.add(signed);
    }, new Decimal(0));

    return signedSum.div(totalNotional);
  }
}
