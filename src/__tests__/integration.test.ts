/**
 * Integration test: validates the full strategy cycle flow
 * from signal generation → risk check → execution → state update.
 *
 * Uses mock Drift/Binance clients to simulate a complete cycle
 * without touching real infrastructure.
 */
import Decimal from "decimal.js";
import { StrategyEngine } from "../strategy/engine";
import { FundingRate, Position } from "../strategy/types";

// Mock config
jest.mock("../config", () => ({
  config: {
    maxLeverage: new (require("decimal.js"))("2.0"),
    healthRatioFloor: new (require("decimal.js"))("1.10"),
    maxDrawdownPct: new (require("decimal.js"))("3.0"),
    minFundingAPY: new (require("decimal.js"))("0.05"),
    strategyMode: "drift-only",
    targetAssets: ["SOL", "BTC", "ETH"],
    rebalanceIntervalMs: 28800000,
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

jest.mock("../drift/client", () => ({ DriftManager: jest.fn() }));
jest.mock("../binance/client", () => ({ BinanceManager: jest.fn() }));
jest.mock("../drift/data-api", () => ({
  DriftDataAPI: jest.fn().mockImplementation(() => ({
    getDepositRateHistory: jest.fn().mockResolvedValue([]),
    getBorrowRateHistory: jest.fn().mockResolvedValue([]),
  })),
}));
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

function makeFundingRate(
  asset: string,
  venue: string,
  annualized: number,
  nextSettlementMs: number = 3600_000
): FundingRate {
  return {
    asset,
    venue,
    rate: new Decimal(annualized / (24 * 365.25)),
    annualizedRate: new Decimal(annualized),
    timestamp: Date.now(),
    nextSettlement: Date.now() + nextSettlementMs,
  };
}

function makeDriftMock() {
  return {
    getFundingRates: jest.fn().mockResolvedValue([]),
    getPositions: jest.fn().mockResolvedValue([]),
    getHealthRatio: jest.fn().mockResolvedValue(new Decimal("5")),
    getUnrealizedFundingPnl: jest.fn().mockReturnValue(new Decimal("0")),
    getFreeCollateral: jest.fn().mockReturnValue(new Decimal("1000")),
    buySpot: jest.fn().mockResolvedValue(undefined),
    sellSpot: jest.fn().mockResolvedValue(undefined),
    shortPerp: jest.fn().mockResolvedValue(undefined),
    longPerp: jest.fn().mockResolvedValue(undefined),
    closePerp: jest.fn().mockResolvedValue(undefined),
    settleFunding: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe("Integration: Full Strategy Cycle", () => {
  let engine: StrategyEngine;
  let drift: ReturnType<typeof makeDriftMock>;

  beforeEach(() => {
    drift = makeDriftMock();
    engine = new StrategyEngine(drift, null, new Decimal("1000"));
  });

  it("completes a full cycle: generate signals → execute → update state", async () => {
    // Set up attractive SOL funding
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.12),   // 12% APY
      makeFundingRate("BTC", "drift", 0.08),   // 8% APY
      makeFundingRate("ETH", "drift", 0.02),   // 2% — below minFundingAPY
    ]);

    await engine.runCycle();

    const state = engine.getState();

    // Should have executed trades for SOL and BTC (ETH below min)
    expect(drift.buySpot).toHaveBeenCalled();
    expect(drift.shortPerp).toHaveBeenCalled();

    // State should be updated
    expect(state.cycleCount).toBe(1);
    expect(state.lastRebalance).toBeGreaterThan(0);
    expect(state.regime).toBeDefined();
  });

  it("skips execution near funding settlement", async () => {
    // Settlement in 2 minutes (< 5 min threshold)
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.15, 120_000),
    ]);

    await engine.runCycle();

    // Should NOT have executed any trades
    expect(drift.buySpot).not.toHaveBeenCalled();
    expect(drift.shortPerp).not.toHaveBeenCalled();
  });

  it("tracks funding PnL across cycles", async () => {
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.10),
    ]);

    // Cycle 1: open position
    await engine.runCycle();

    // Simulate funding accrual
    drift.getUnrealizedFundingPnl.mockReturnValue(new Decimal("0.50"));

    // Cycle 2: funding should be tracked
    await engine.runCycle();

    const state = engine.getState();
    expect(state.totalFundingCollected.gt(0)).toBe(true);
    expect(state.cycleCount).toBe(2);
  });

  it("handles regime changes between cycles", async () => {
    // Cycle 1: neutral market
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.02),
      makeFundingRate("BTC", "drift", 0.01),
      makeFundingRate("ETH", "drift", -0.01),
    ]);
    await engine.runCycle();
    expect(engine.getState().regime).toBe("neutral");

    // Cycle 2: bull market (strongly positive funding)
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.25),
      makeFundingRate("BTC", "drift", 0.30),
      makeFundingRate("ETH", "drift", 0.20),
    ]);
    await engine.runCycle();
    expect(engine.getState().regime).toBe("bull");
  });

  it("produces a valid APY estimate after multiple cycles", async () => {
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.12),
    ]);

    // Simulate time passing by running multiple cycles
    drift.getUnrealizedFundingPnl.mockReturnValue(new Decimal("0.10"));
    await engine.runCycle();

    drift.getUnrealizedFundingPnl.mockReturnValue(new Decimal("0.30"));
    await engine.runCycle();

    const state = engine.getState();
    // APY should be calculated (may be very large for short time periods)
    expect(state.apyEstimate.isFinite()).toBe(true);
  });

  it("handles bi-directional funding across multiple assets", async () => {
    // SOL positive, BTC negative — both should generate signals
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.10),   // positive → short perp
      makeFundingRate("BTC", "drift", -0.12),  // negative → long perp
    ]);

    await engine.runCycle();

    // Both SOL and BTC should have trades
    // SOL: buy spot + short perp
    expect(drift.buySpot).toHaveBeenCalled();
    expect(drift.shortPerp).toHaveBeenCalled();

    // BTC: sell spot (short) + long perp
    expect(drift.sellSpot).toHaveBeenCalled();
    expect(drift.longPerp).toHaveBeenCalled();
  });

  it("emergency unwind closes all positions", async () => {
    // Set up a position
    drift.getFundingRates.mockResolvedValue([
      makeFundingRate("SOL", "drift", 0.10),
    ]);
    await engine.runCycle();

    // Trigger emergency unwind
    await engine.emergencyUnwind();

    const state = engine.getState();
    expect(state.deployedCapital.eq(0)).toBe(true);
    // closePerp should have been called for each target asset
    expect(drift.closePerp).toHaveBeenCalled();
  });
});
