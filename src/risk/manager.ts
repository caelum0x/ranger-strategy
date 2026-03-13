import Decimal from "decimal.js";
import { config } from "../config";
import { Position, RiskCheck, StrategyState } from "../strategy/types";
import { logger } from "../utils/logger";

export class RiskManager {
  private maxLeverage: Decimal;
  private healthRatioFloor: Decimal;
  private maxDrawdownPct: Decimal;
  private initialCapital: Decimal;

  constructor(initialCapital: Decimal) {
    this.maxLeverage = config.maxLeverage;
    this.healthRatioFloor = config.healthRatioFloor;
    this.maxDrawdownPct = config.maxDrawdownPct;
    this.initialCapital = initialCapital;
  }

  checkRisk(state: StrategyState): RiskCheck {
    const violations: string[] = [];

    // Check health ratio
    if (state.healthRatio.lt(this.healthRatioFloor)) {
      violations.push(
        `Health ratio ${state.healthRatio.toFixed(4)} below floor ${this.healthRatioFloor.toFixed(4)}`
      );
    }

    // Check drawdown
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

    // Check delta neutrality
    const netDelta = this.calculateNetDelta(state.positions);
    const deltaThreshold = new Decimal("0.05"); // 5% delta tolerance
    if (netDelta.abs().gt(deltaThreshold)) {
      violations.push(
        `Net delta ${netDelta.toFixed(4)} exceeds threshold ${deltaThreshold.toFixed(4)}`
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

    // Drawdown circuit breaker
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

    const size = Decimal.max(minSize, Decimal.min(baseSize, maxSize));

    logger.info(`Position size for ${asset}: $${size.toFixed(2)}`, {
      availableCapital: availableCapital.toFixed(2),
      predictedFundingRate: predictedFundingRate.toFixed(6),
      confidence: confidence.toFixed(4),
    });

    return size;
  }

  private calculateDrawdown(state: StrategyState): Decimal {
    const currentValue = state.totalCapital.add(state.totalPnl);
    if (currentValue.gte(this.initialCapital)) return new Decimal(0);
    return this.initialCapital.sub(currentValue).div(this.initialCapital).mul(100);
  }

  private calculateTotalLeverage(state: StrategyState): Decimal {
    const totalNotional = state.positions.reduce(
      (sum, p) => sum.add(p.notionalValue),
      new Decimal(0)
    );
    if (state.totalCapital.isZero()) return new Decimal(0);
    return totalNotional.div(state.totalCapital);
  }

  private calculateNetDelta(positions: Position[]): Decimal {
    return positions.reduce((delta, p) => {
      const signed = p.side === "long" ? p.notionalValue : p.notionalValue.neg();
      return delta.add(signed);
    }, new Decimal(0));
  }
}
