import Decimal from "decimal.js";
import { StrategyEngine } from "../strategy/engine";
import { FundingRate, Position } from "../strategy/types";

// Mock config
jest.mock("../config", () => ({
  config: {
    maxLeverage: new (require("decimal.js"))("2.0"),
    healthRatioFloor: new (require("decimal.js"))("1.10"),
    maxDrawdownPct: new (require("decimal.js"))("3.0"),
    targetAssets: ["SOL", "BTC", "ETH"],
  },
}));

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock DriftManager
jest.mock("../drift/client", () => ({
  DriftManager: jest.fn(),
}));

// Mock BinanceManager
jest.mock("../binance/client", () => ({
  BinanceManager: jest.fn(),
}));

// Mock RiskManager — let the real implementation run since it's pure logic
jest.mock("../risk/manager", () => {
  const Decimal = require("decimal.js");
  return {
    RiskManager: jest.fn().mockImplementation(() => ({
      checkRisk: jest.fn().mockReturnValue({
        passed: true,
        healthRatio: new Decimal("5"),
        drawdown: new Decimal("0"),
        leverage: new Decimal("1"),
        violations: [],
      }),
      shouldEmergencyUnwind: jest.fn().mockReturnValue(false),
      calculatePositionSize: jest.fn().mockReturnValue(new Decimal("100")),
    })),
  };
});

function makeDriftMock() {
  return {
    getFundingRates: jest.fn().mockResolvedValue([]),
    getPositions: jest.fn().mockResolvedValue([]),
    getHealthRatio: jest.fn().mockResolvedValue(new Decimal("5")),
    getUnrealizedFundingPnl: jest.fn().mockReturnValue(new Decimal("0")),
    buySpot: jest.fn().mockResolvedValue(undefined),
    sellSpot: jest.fn().mockResolvedValue(undefined),
    shortPerp: jest.fn().mockResolvedValue(undefined),
    closePerp: jest.fn().mockResolvedValue(undefined),
    settleFunding: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeBinanceMock() {
  return {
    getFundingRates: jest.fn().mockResolvedValue([]),
    getPositions: jest.fn().mockResolvedValue([]),
    shortPerp: jest.fn().mockResolvedValue(undefined),
    closePerp: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeFundingRate(
  asset: string,
  venue: string,
  annualized: number
): FundingRate {
  return {
    asset,
    venue,
    rate: new Decimal(annualized / (24 * 365.25)),
    annualizedRate: new Decimal(annualized),
    timestamp: Date.now(),
    nextSettlement: Date.now() + 3600_000,
  };
}

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

describe("StrategyEngine", () => {
  let engine: StrategyEngine;
  let drift: ReturnType<typeof makeDriftMock>;
  let binance: ReturnType<typeof makeBinanceMock>;

  beforeEach(() => {
    drift = makeDriftMock();
    binance = makeBinanceMock();
    engine = new StrategyEngine(drift, binance, new Decimal("1000"));
  });

  // ── generateSignals ────────────────────────────────────────────────

  describe("generateSignals", () => {
    it("opens positions when funding is attractive", () => {
      const driftRates = [makeFundingRate("SOL", "drift", 0.10)];
      const binanceRates = [makeFundingRate("SOL", "binance", 0.20)];

      const signals = engine.generateSignals(driftRates, binanceRates);

      const openSignals = signals.filter((s) => s.action === "open");
      expect(openSignals.length).toBeGreaterThan(0);
      expect(openSignals[0].asset).toBe("SOL");
      expect(openSignals[0].spotVenue).toBe("drift");
      expect(openSignals[0].perpVenue).toBe("binance");
    });

    it("closes positions when funding becomes unattractive", () => {
      // Manually inject a position into the engine state
      const state = engine.getState();
      // We need to set state with an existing position for an asset
      // that won't appear in the attractive ranked list
      (engine as any).state.positions = [
        makePosition({ asset: "SOL", venue: "drift" }),
      ];
      (engine as any).state.idleCapital = new Decimal("500");

      // Funding is now zero/negative — SOL won't be attractive
      const driftRates = [makeFundingRate("SOL", "drift", -0.01)];
      const binanceRates = [makeFundingRate("SOL", "binance", -0.01)];

      const signals = engine.generateSignals(driftRates, binanceRates);

      const closeSignals = signals.filter((s) => s.action === "close");
      expect(closeSignals.length).toBeGreaterThan(0);
      expect(closeSignals[0].asset).toBe("SOL");
      expect(closeSignals[0].reason).toContain("no longer attractive");
    });

    it("does not open when idle capital is below minimum", () => {
      // Set idle capital to below $5 threshold
      (engine as any).state.idleCapital = new Decimal("3");

      const driftRates = [makeFundingRate("SOL", "drift", 0.10)];
      const binanceRates = [makeFundingRate("SOL", "binance", 0.20)];

      const signals = engine.generateSignals(driftRates, binanceRates);

      const openSignals = signals.filter((s) => s.action === "open");
      expect(openSignals).toHaveLength(0);
    });
  });

  // ── detectRegime ───────────────────────────────────────────────────

  describe("detectRegime", () => {
    it("classifies bull when avg funding is strongly positive", () => {
      const rates = [
        makeFundingRate("SOL", "drift", 0.20),
        makeFundingRate("BTC", "drift", 0.25),
        makeFundingRate("ETH", "drift", 0.30),
      ];
      expect(engine.detectRegime(rates)).toBe("bull");
    });

    it("classifies bear when avg funding is negative", () => {
      const rates = [
        makeFundingRate("SOL", "drift", -0.10),
        makeFundingRate("BTC", "drift", -0.15),
        makeFundingRate("ETH", "drift", -0.20),
      ];
      expect(engine.detectRegime(rates)).toBe("bear");
    });

    it("classifies neutral when avg funding is near zero", () => {
      const rates = [
        makeFundingRate("SOL", "drift", 0.01),
        makeFundingRate("BTC", "drift", -0.01),
        makeFundingRate("ETH", "drift", 0.02),
      ];
      expect(engine.detectRegime(rates)).toBe("neutral");
    });

    it("classifies volatile when stddev is high", () => {
      // Large spread between rates creates high variance
      const rates = [
        makeFundingRate("SOL", "drift", 1.0),
        makeFundingRate("BTC", "drift", -1.0),
        makeFundingRate("ETH", "drift", 0.5),
      ];
      expect(engine.detectRegime(rates)).toBe("volatile");
    });

    it("returns neutral for empty rates", () => {
      expect(engine.detectRegime([])).toBe("neutral");
    });
  });
});
