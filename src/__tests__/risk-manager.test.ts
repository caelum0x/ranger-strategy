import Decimal from "decimal.js";
import { RiskManager } from "../risk/manager";
import { Position, StrategyState } from "../strategy/types";

// Mock config
jest.mock("../config", () => ({
  config: {
    maxLeverage: new (require("decimal.js"))("2.0"),
    healthRatioFloor: new (require("decimal.js"))("1.10"),
    maxDrawdownPct: new (require("decimal.js"))("3.0"),
    targetAssets: ["SOL", "BTC", "ETH"],
  },
}));

// Silence logger during tests
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    asset: "SOL",
    side: "long",
    venue: "drift",
    size: new Decimal("1"),
    entryPrice: new Decimal("100"),
    currentPrice: new Decimal("100"),
    notionalValue: new Decimal("100"),
    unrealizedPnl: new Decimal("0"),
    leverage: new Decimal("1"),
    healthRatio: new Decimal("5"),
    timestamp: Date.now(),
    ...overrides,
  };
}

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

describe("RiskManager", () => {
  let rm: RiskManager;

  beforeEach(() => {
    rm = new RiskManager(new Decimal("1000"));
  });

  // ── checkRisk ──────────────────────────────────────────────────────

  describe("checkRisk", () => {
    it("passes with healthy state", () => {
      const state = makeState({
        healthRatio: new Decimal("3.0"),
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("10"),
        positions: [
          makePosition({ asset: "SOL", side: "long", notionalValue: new Decimal("500") }),
          makePosition({ asset: "SOL", side: "short", notionalValue: new Decimal("500") }),
        ],
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("fails with low health ratio", () => {
      const state = makeState({ healthRatio: new Decimal("1.05") });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain("Health ratio");
    });

    it("fails with high drawdown from peak equity", () => {
      // First, establish a peak equity of 1050 by checking risk with positive PnL
      rm.checkRisk(makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("50"), // peak equity = 1050
      }));

      // Now check with a drawdown from peak
      // currentEquity = 1000 + (-20) = 980
      // drawdown = (1050 - 980) / 1050 * 100 = 6.67% > 3%
      const state = makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("-20"),
        healthRatio: new Decimal("5"),
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("Drawdown"))).toBe(true);
    });

    it("uses peak equity (not initial capital) for drawdown", () => {
      // Set peak equity to 1200
      rm.checkRisk(makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("200"), // peak = 1200
      }));

      // Equity drops to 1170 → drawdown = (1200 - 1170) / 1200 = 2.5% < 3% → passes
      const state = makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("170"),
        healthRatio: new Decimal("5"),
      });
      const result = rm.checkRisk(state);
      expect(result.passed).toBe(true);
    });

    it("fails with per-asset-pair delta imbalance", () => {
      // SOL has mismatched legs: $200 long but only $100 short
      // relative delta = (200 - 100) / (200 + 100) = 0.333 > 0.05
      const state = makeState({
        healthRatio: new Decimal("5"),
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("0"),
        positions: [
          makePosition({ asset: "SOL", side: "long", notionalValue: new Decimal("200") }),
          makePosition({ asset: "SOL", side: "short", notionalValue: new Decimal("100") }),
        ],
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("SOL") && v.includes("delta"))).toBe(true);
    });

    it("detects health ratio spike (sudden drop)", () => {
      // First check with healthy ratio to establish baseline
      rm.checkRisk(makeState({ healthRatio: new Decimal("4.0") }));

      // Second check with sudden drop (>50% decline)
      const state = makeState({ healthRatio: new Decimal("1.5") });
      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("spike"))).toBe(true);
    });

    it("passes when per-asset delta is balanced", () => {
      // Balanced delta-neutral pair: $100 long spot + $100 short perp
      const state = makeState({
        healthRatio: new Decimal("5"),
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("0"),
        positions: [
          makePosition({ asset: "SOL", side: "long", notionalValue: new Decimal("100") }),
          makePosition({ asset: "SOL", side: "short", notionalValue: new Decimal("100") }),
        ],
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(true);
    });
  });

  // ── shouldEmergencyUnwind ──────────────────────────────────────────

  describe("shouldEmergencyUnwind", () => {
    it("returns true when health ratio < 1.05", () => {
      const state = makeState({ healthRatio: new Decimal("1.02") });
      expect(rm.shouldEmergencyUnwind(state)).toBe(true);
    });

    it("returns false when health ratio >= 1.05", () => {
      const state = makeState({ healthRatio: new Decimal("2.0") });
      expect(rm.shouldEmergencyUnwind(state)).toBe(false);
    });

    it("returns true when drawdown exceeds max from peak", () => {
      // Set peak equity first
      rm.checkRisk(makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("0"),
      }));

      // drawdown = (1000 - 960) / 1000 * 100 = 4% > maxDrawdownPct=3%
      const state = makeState({
        healthRatio: new Decimal("5"),
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("-40"),
      });
      expect(rm.shouldEmergencyUnwind(state)).toBe(true);
    });
  });

  // ── calculatePositionSize ──────────────────────────────────────────

  describe("calculatePositionSize", () => {
    it("returns a reasonable position size", () => {
      const size = rm.calculatePositionSize(
        new Decimal("900"),    // available capital
        "SOL",
        new Decimal("0.10"),   // 10% annualized funding
        new Decimal("0.80")    // 80% confidence
      );

      // Should be >= $5 (minimum) and <= 900/3 = 300 (max per asset)
      expect(size.gte(new Decimal("5"))).toBe(true);
      expect(size.lte(new Decimal("300"))).toBe(true);
    });

    it("clamps to minimum $5 for very small edge", () => {
      const size = rm.calculatePositionSize(
        new Decimal("900"),
        "BTC",
        new Decimal("0.00001"), // tiny funding
        new Decimal("0.1")     // low confidence
      );
      expect(size.eq(new Decimal("5"))).toBe(true);
    });

    it("clamps to max per-asset allocation for large edge", () => {
      const size = rm.calculatePositionSize(
        new Decimal("900"),
        "ETH",
        new Decimal("0.50"), // huge funding
        new Decimal("1.0")   // full confidence
      );
      // maxPerAsset = 900 / 3 = 300
      expect(size.eq(new Decimal("300"))).toBe(true);
    });

    it("respects leverage bound", () => {
      // maxLeverage = 2.0, availableCapital = 10
      // leverageCap = 2.0 * 10 = 20
      // Without cap, size would be 10/3 * (0.50 * 1.0 / 0.01) = 166.67
      // But leverage cap = 2.0 * 10 = 20
      const size = rm.calculatePositionSize(
        new Decimal("10"),
        "ETH",
        new Decimal("0.50"),
        new Decimal("1.0")
      );
      expect(size.lte(new Decimal("20"))).toBe(true);
    });
  });
});
