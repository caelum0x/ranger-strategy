import Decimal from "decimal.js";
import { YieldAnalytics } from "../utils/yield-analytics";
import { StrategyState, Position } from "../strategy/types";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makeState(overrides: Partial<StrategyState> = {}): StrategyState {
  return {
    totalCapital: new Decimal("1000"),
    deployedCapital: new Decimal("500"),
    idleCapital: new Decimal("500"),
    positions: [],
    totalPnl: new Decimal("0"),
    totalFundingCollected: new Decimal("0"),
    totalLendingCollected: new Decimal("0"),
    totalTradingCosts: new Decimal("0"),
    currentDrawdown: new Decimal("0"),
    maxDrawdownHit: new Decimal("0"),
    healthRatio: new Decimal("5"),
    apyEstimate: new Decimal("0"),
    lastRebalance: 0,
    regime: "neutral",
    cycleCount: 0,
    directionFlips: 0,
    ...overrides,
  };
}

describe("YieldAnalytics", () => {
  let analytics: YieldAnalytics;

  beforeEach(() => {
    analytics = new YieldAnalytics();
  });

  describe("calculateBreakdown", () => {
    it("calculates net yield correctly", () => {
      const state = makeState({
        totalFundingCollected: new Decimal("10"),
        totalLendingCollected: new Decimal("3"),
        totalTradingCosts: new Decimal("2"),
      });

      const breakdown = analytics.calculateBreakdown(state);

      expect(breakdown.fundingIncome.eq(new Decimal("10"))).toBe(true);
      expect(breakdown.lendingIncome.eq(new Decimal("3"))).toBe(true);
      expect(breakdown.tradingCosts.eq(new Decimal("2"))).toBe(true);
      // Net = 10 + 3 - 0 - 2 = 11
      expect(breakdown.netYield.eq(new Decimal("11"))).toBe(true);
    });

    it("calculates capital utilization", () => {
      const state = makeState({
        totalCapital: new Decimal("1000"),
        deployedCapital: new Decimal("750"),
      });

      const breakdown = analytics.calculateBreakdown(state);
      expect(breakdown.capitalUtilization.toNumber()).toBeCloseTo(0.75, 2);
    });

    it("handles zero capital gracefully", () => {
      const state = makeState({
        totalCapital: new Decimal("0"),
        deployedCapital: new Decimal("0"),
      });

      const breakdown = analytics.calculateBreakdown(state);
      expect(breakdown.capitalUtilization.eq(0)).toBe(true);
      expect(breakdown.annualizedAPY.eq(0)).toBe(true);
    });

    it("calculates risk-adjusted return", () => {
      const state = makeState({
        totalFundingCollected: new Decimal("50"),
        totalCapital: new Decimal("1000"),
        maxDrawdownHit: new Decimal("2.0"),
      });

      const breakdown = analytics.calculateBreakdown(state);
      // APY is time-dependent, but risk-adjusted = APY / maxDrawdown
      expect(breakdown.riskAdjustedReturn.isFinite()).toBe(true);
    });
  });

  describe("calculateAssetAttribution", () => {
    it("attributes yield per asset", () => {
      const positions: Position[] = [
        {
          asset: "SOL",
          side: "long",
          venue: "drift",
          size: new Decimal("1"),
          entryPrice: new Decimal("150"),
          currentPrice: new Decimal("150"),
          notionalValue: new Decimal("150"),
          unrealizedPnl: new Decimal("0"),
          leverage: new Decimal("1"),
          healthRatio: new Decimal("5"),
          timestamp: Date.now(),
        },
        {
          asset: "SOL",
          side: "short",
          venue: "drift",
          size: new Decimal("1"),
          entryPrice: new Decimal("150"),
          currentPrice: new Decimal("150"),
          notionalValue: new Decimal("150"),
          unrealizedPnl: new Decimal("0"),
          leverage: new Decimal("1"),
          healthRatio: new Decimal("5"),
          timestamp: Date.now(),
        },
      ];

      const fundingRates = new Map<string, Decimal>();
      fundingRates.set("SOL", new Decimal("0.10")); // 10% annualized

      const attributions = analytics.calculateAssetAttribution(
        positions,
        fundingRates
      );

      expect(attributions).toHaveLength(1);
      expect(attributions[0].asset).toBe("SOL");
      expect(attributions[0].estimatedAnnualYield.gt(0)).toBe(true);
    });

    it("sorts by estimated annual yield descending", () => {
      const positions: Position[] = [
        {
          asset: "SOL",
          side: "long",
          venue: "drift",
          size: new Decimal("1"),
          entryPrice: new Decimal("150"),
          currentPrice: new Decimal("150"),
          notionalValue: new Decimal("100"),
          unrealizedPnl: new Decimal("0"),
          leverage: new Decimal("1"),
          healthRatio: new Decimal("5"),
          timestamp: Date.now(),
        },
        {
          asset: "BTC",
          side: "long",
          venue: "drift",
          size: new Decimal("0.01"),
          entryPrice: new Decimal("60000"),
          currentPrice: new Decimal("60000"),
          notionalValue: new Decimal("600"),
          unrealizedPnl: new Decimal("0"),
          leverage: new Decimal("1"),
          healthRatio: new Decimal("5"),
          timestamp: Date.now(),
        },
      ];

      const fundingRates = new Map<string, Decimal>();
      fundingRates.set("SOL", new Decimal("0.08"));
      fundingRates.set("BTC", new Decimal("0.12"));

      const attributions = analytics.calculateAssetAttribution(
        positions,
        fundingRates
      );

      expect(attributions[0].asset).toBe("BTC"); // Higher yield
    });
  });

  describe("formatBreakdown", () => {
    it("formats all fields as strings", () => {
      const state = makeState({
        totalFundingCollected: new Decimal("5.1234"),
        totalLendingCollected: new Decimal("1.5678"),
        totalTradingCosts: new Decimal("0.8901"),
      });

      const breakdown = analytics.calculateBreakdown(state);
      const formatted = analytics.formatBreakdown(breakdown);

      expect(formatted.fundingIncome).toBe("$5.1234");
      expect(formatted.lendingIncome).toBe("$1.5678");
      expect(formatted.tradingCosts).toBe("-$0.8901");
      expect(formatted.netYield).toContain("$");
      expect(formatted.annualizedAPY).toContain("%");
    });
  });

  describe("getYieldTrend", () => {
    it("returns stable when no snapshots", () => {
      const trend = analytics.getYieldTrend();
      expect(trend.direction).toBe("stable");
      expect(trend.hourlyRate.eq(0)).toBe(true);
    });

    it("detects improving yield trend", () => {
      // Simulate increasing yield across snapshots
      const state1 = makeState({ totalFundingCollected: new Decimal("1") });
      const state2 = makeState({ totalFundingCollected: new Decimal("5") });

      analytics.calculateBreakdown(state1);
      // Manually push a second snapshot with later timestamp
      (analytics as any).yieldSnapshots.push({
        timestamp: Date.now() + 3600000,
        netYield: new Decimal("5"),
        equity: new Decimal("1005"),
      });

      const trend = analytics.getYieldTrend();
      expect(trend.hourlyRate.gt(0)).toBe(true);
    });
  });
});
