/**
 * Yield analytics module for real-time strategy performance tracking.
 *
 * Provides:
 * - Net yield breakdown (funding + lending - borrow costs - trading costs)
 * - APY projection based on observed data
 * - Per-asset yield attribution
 * - Risk-adjusted return metrics (Sharpe ratio estimate)
 */
import Decimal from "decimal.js";
import { StrategyState, Position } from "../strategy/types";
import { logger } from "./logger";

export interface YieldBreakdown {
  /** Funding income from perp positions (both directions) */
  fundingIncome: Decimal;
  /** Lending income from long spot deposits */
  lendingIncome: Decimal;
  /** Borrow costs from short spot positions */
  borrowCosts: Decimal;
  /** Trading fees (entry + exit) */
  tradingCosts: Decimal;
  /** Net yield = funding + lending - borrow - trading */
  netYield: Decimal;
  /** Annualized percentage yield */
  annualizedAPY: Decimal;
  /** Time-weighted capital deployed */
  capitalUtilization: Decimal;
  /** Risk-adjusted return (simplified Sharpe: APY / maxDrawdown) */
  riskAdjustedReturn: Decimal;
}

export interface AssetYieldAttribution {
  asset: string;
  fundingDirection: "collecting" | "paying" | "none";
  spotSide: "long" | "short" | "none";
  notionalValue: Decimal;
  estimatedDailyYield: Decimal;
  estimatedAnnualYield: Decimal;
}

export class YieldAnalytics {
  private startTime: number;
  private yieldSnapshots: Array<{
    timestamp: number;
    netYield: Decimal;
    equity: Decimal;
  }> = [];

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Calculate comprehensive yield breakdown from current state.
   */
  calculateBreakdown(state: StrategyState): YieldBreakdown {
    const fundingIncome = state.totalFundingCollected;
    const lendingIncome = state.totalLendingCollected;
    const tradingCosts = state.totalTradingCosts;

    // Borrow costs are embedded in totalTradingCosts for now
    // In the future, they can be tracked separately
    const borrowCosts = new Decimal(0);

    const netYield = fundingIncome
      .add(lendingIncome)
      .sub(borrowCosts)
      .sub(tradingCosts);

    // Calculate annualized APY
    const elapsedMs = Date.now() - this.startTime;
    const elapsedDays = elapsedMs / (86400 * 1000);
    let annualizedAPY = new Decimal(0);

    if (elapsedDays > 0 && state.totalCapital.gt(0)) {
      const returnSoFar = netYield.div(state.totalCapital);
      annualizedAPY = returnSoFar.div(elapsedDays).mul(365.25).mul(100);
    }

    // Capital utilization: deployed / total
    const capitalUtilization = state.totalCapital.gt(0)
      ? state.deployedCapital.div(state.totalCapital)
      : new Decimal(0);

    // Risk-adjusted return: APY / max drawdown (simplified Sharpe)
    const riskAdjustedReturn = state.maxDrawdownHit.gt(0)
      ? annualizedAPY.div(state.maxDrawdownHit)
      : annualizedAPY;

    // Record snapshot for trend analysis
    this.yieldSnapshots.push({
      timestamp: Date.now(),
      netYield,
      equity: state.totalCapital.add(state.totalPnl),
    });

    // Keep only last 1000 snapshots
    if (this.yieldSnapshots.length > 1000) {
      this.yieldSnapshots = this.yieldSnapshots.slice(-1000);
    }

    return {
      fundingIncome,
      lendingIncome,
      borrowCosts,
      tradingCosts,
      netYield,
      annualizedAPY,
      capitalUtilization,
      riskAdjustedReturn,
    };
  }

  /**
   * Per-asset yield attribution — which assets contribute most to yield.
   */
  calculateAssetAttribution(
    positions: Position[],
    fundingRates: Map<string, Decimal>
  ): AssetYieldAttribution[] {
    const attributions: AssetYieldAttribution[] = [];

    // Group positions by asset
    const assetPositions = new Map<string, Position[]>();
    for (const pos of positions) {
      const existing = assetPositions.get(pos.asset) || [];
      existing.push(pos);
      assetPositions.set(pos.asset, existing);
    }

    for (const [asset, poses] of assetPositions) {
      const spotPos = poses.find((p) => p.side === "long" || p.side === "short");
      const fundingRate = fundingRates.get(asset) || new Decimal(0);

      const notionalValue = poses.reduce(
        (sum, p) => sum.add(p.notionalValue),
        new Decimal(0)
      );

      // Daily yield from funding
      const dailyFundingRate = fundingRate.div(365.25);
      const estimatedDailyYield = notionalValue.div(2).mul(dailyFundingRate.abs());
      const estimatedAnnualYield = estimatedDailyYield.mul(365.25);

      const fundingDirection: "collecting" | "paying" | "none" = fundingRate.isZero()
        ? "none"
        : "collecting"; // delta-neutral always collects

      attributions.push({
        asset,
        fundingDirection,
        spotSide: spotPos?.side || "none",
        notionalValue,
        estimatedDailyYield,
        estimatedAnnualYield,
      });
    }

    return attributions.sort((a, b) =>
      b.estimatedAnnualYield.minus(a.estimatedAnnualYield).toNumber()
    );
  }

  /**
   * Format yield breakdown for display/logging.
   */
  formatBreakdown(breakdown: YieldBreakdown): Record<string, string> {
    return {
      fundingIncome: `$${breakdown.fundingIncome.toFixed(4)}`,
      lendingIncome: `$${breakdown.lendingIncome.toFixed(4)}`,
      borrowCosts: `-$${breakdown.borrowCosts.toFixed(4)}`,
      tradingCosts: `-$${breakdown.tradingCosts.toFixed(4)}`,
      netYield: `$${breakdown.netYield.toFixed(4)}`,
      annualizedAPY: `${breakdown.annualizedAPY.toFixed(2)}%`,
      capitalUtilization: `${breakdown.capitalUtilization.mul(100).toFixed(1)}%`,
      riskAdjustedReturn: `${breakdown.riskAdjustedReturn.toFixed(2)}`,
    };
  }

  /**
   * Get yield trend over recent snapshots.
   * Returns rate of yield accrual (yield per hour).
   */
  getYieldTrend(): { hourlyRate: Decimal; direction: "improving" | "declining" | "stable" } {
    if (this.yieldSnapshots.length < 2) {
      return { hourlyRate: new Decimal(0), direction: "stable" };
    }

    const recent = this.yieldSnapshots.slice(-10);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];

    const timeDiffHours = (newest.timestamp - oldest.timestamp) / (3600 * 1000);
    if (timeDiffHours <= 0) {
      return { hourlyRate: new Decimal(0), direction: "stable" };
    }

    const yieldDiff = newest.netYield.sub(oldest.netYield);
    const hourlyRate = yieldDiff.div(timeDiffHours);

    const direction = hourlyRate.gt(0.001)
      ? "improving"
      : hourlyRate.lt(-0.001)
        ? "declining"
        : "stable";

    return { hourlyRate, direction };
  }
}
