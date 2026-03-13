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
    currentDrawdown: new Decimal("0"),
    maxDrawdownHit: new Decimal("0"),
    healthRatio: new Decimal("5"),
    apyEstimate: new Decimal("0"),
    lastRebalance: 0,
    regime: "neutral",
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
          makePosition({ side: "long", notionalValue: new Decimal("500") }),
          makePosition({ side: "short", notionalValue: new Decimal("500") }),
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

    it("fails with high drawdown", () => {
      // initialCapital=1000, currentValue = totalCapital + totalPnl = 1000 + (-50) = 950
      // drawdown = (1000 - 950) / 1000 * 100 = 5% > maxDrawdownPct=3%
      const state = makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("-50"),
        healthRatio: new Decimal("5"), // keep health fine
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("Drawdown"))).toBe(true);
    });

    it("fails with excessive leverage", () => {
      // totalNotional = 3000, totalCapital = 1000 → leverage = 3x > maxLeverage=2x
      const state = makeState({
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("0"),
        healthRatio: new Decimal("5"),
        positions: [
          makePosition({ side: "long", notionalValue: new Decimal("1500") }),
          makePosition({ side: "short", notionalValue: new Decimal("1500") }),
        ],
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("Leverage"))).toBe(true);
    });

    it("fails with delta imbalance", () => {
      // Net delta: +200 long - 100 short = +100
      // As fraction of... the threshold is absolute 0.05
      // With notionalValue: long=200, short=100, net delta = 200 - 100 = 100
      // 100 > 0.05 threshold → violation
      const state = makeState({
        healthRatio: new Decimal("5"),
        totalCapital: new Decimal("1000"),
        totalPnl: new Decimal("0"),
        positions: [
          makePosition({ side: "long", notionalValue: new Decimal("200") }),
          makePosition({ side: "short", notionalValue: new Decimal("100") }),
        ],
      });

      const result = rm.checkRisk(state);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.includes("delta"))).toBe(true);
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

    it("returns true when drawdown exceeds max", () => {
      // drawdown = (1000 - 960) / 1000 * 100 = 4% > maxDrawdownPct=3%
      const state = makeState({
        healthRatio: new Decimal("5"), // health is fine
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
  });
});
