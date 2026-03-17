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
    strategyProfile: "generic",
    driftBearNeutralAllocation: new (require("decimal.js"))("0.50"),
    driftBearTopAssetOnly: true,
    targetAssets: ["SOL", "BTC", "ETH"],
    rebalanceIntervalMs: 28800000,
    oracleMaxSpreadBps: 50,
    oracleMaxConfidenceBps: 50,
    oracleSizeFloor: new (require("decimal.js"))("0.4"),
    oracleSkipMultiplier: new (require("decimal.js"))("2.5"),
    openRouterApiKey: "",
    solanaRpcUrl: "https://api.devnet.solana.com",
    heliusRpcUrl: "",
  },
}));

// Mock global fetch
global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as any;

// Mock new integrated modules
jest.mock("../ranger/data-api", () => ({ RangerDataApi: jest.fn().mockImplementation(() => ({ getFundingRateArbs: jest.fn().mockResolvedValue([]), getLiquidationsCapitulation: jest.fn().mockResolvedValue([]), getBorrowRatesAccumulated: jest.fn().mockResolvedValue([]) })) }));
jest.mock("../lending/sanctum", () => ({ getBestLSTForYield: jest.fn().mockResolvedValue(null), getLSTAPY: jest.fn().mockResolvedValue({}), LST_MINTS: {} }));
jest.mock("../utils/pyth-oracle", () => ({ fetchMultiplePrices: jest.fn().mockResolvedValue(new Map()) }));
jest.mock("../utils/helius-enhanced", () => ({ HeliusClient: jest.fn().mockImplementation(() => ({ getPriorityFeeEstimate: jest.fn().mockResolvedValue(50000) })) }));
jest.mock("../venues/flash", () => ({ FlashTradeClient: jest.fn().mockImplementation(() => ({ getFundingRate: jest.fn().mockResolvedValue(null) })) }));
jest.mock("../venues/adrena", () => ({ AdrenaClient: jest.fn().mockImplementation(() => ({ getFundingRate: jest.fn().mockResolvedValue(null) })) }));
jest.mock("../venues/orca", () => ({ OrcaWhirlpoolClient: jest.fn().mockImplementation(() => ({ getTopPools: jest.fn().mockResolvedValue([]) })) }));
jest.mock("../venues/meteora", () => ({ MeteoraClient: jest.fn().mockImplementation(() => ({ getTopPools: jest.fn().mockResolvedValue([]) })) }));
jest.mock("../venues/debridge", () => ({ DeBridgeClient: jest.fn().mockImplementation(() => ({})), CHAIN_IDS: {} }));
jest.mock("../ranger/voltr-client", () => ({ VoltrClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock("../drift/insurance", () => ({ stakeToInsuranceFund: jest.fn().mockResolvedValue("") }));
jest.mock("../drift/adaptor-client", () => ({ DriftBearAdaptorClient: { devnetConfig: jest.fn().mockReturnValue({}) } }));
jest.mock("../drift/spot-filler", () => ({ SpotFillerBot: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), getStats: jest.fn().mockReturnValue({}) })) }));
jest.mock("../drift/pnl-settler", () => ({ PnlSettler: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), getStats: jest.fn().mockReturnValue({}) })) }));
jest.mock("../drift/funding-updater", () => ({ FundingRateUpdater: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), getStats: jest.fn().mockReturnValue({}) })) }));
jest.mock("../drift/orderbook", () => ({ getL2OrderBook: jest.fn().mockResolvedValue({ bids: [], asks: [] }), getEntryQuoteOfPerpTrade: jest.fn().mockResolvedValue({ entryPrice: 150, priceImpact: 0 }), calculatePerpMarketFundingRate: jest.fn().mockResolvedValue({ longRate: 0, shortRate: 0, friendlyString: "" }), getLendingAndBorrowAPY: jest.fn().mockReturnValue({ lendingAPY: 5, borrowAPY: 8 }) }));
jest.mock("../lending/lulo", () => ({ luloLend: jest.fn().mockResolvedValue(""), luloWithdraw: jest.fn().mockResolvedValue("") }));
jest.mock("../strategy/raydium-lp", () => ({ RaydiumLPStrategy: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), getStats: jest.fn().mockReturnValue({}) })) }));

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
    getOracleMetrics: jest.fn().mockReturnValue({
      oraclePrice: new Decimal("150"),
      markPrice: new Decimal("150"),
      confidenceBps: new Decimal("5"),
      spreadBps: new Decimal("10"),
      staleness: 0,
      stale: false,
    }),
    getOraclePrice: jest.fn().mockResolvedValue(new Decimal("150")),
    getClient: jest.fn().mockReturnValue({
      connection: { rpcEndpoint: "https://api.devnet.solana.com" },
      getPerpMarketAccount: jest.fn().mockReturnValue({ amm: {} }),
      getSpotMarketAccount: jest.fn().mockReturnValue(null),
      getOracleDataForPerpMarket: jest.fn().mockReturnValue({ price: { toNumber: () => 150000000 } }),
      getUser: jest.fn().mockReturnValue({ getTokenAmount: jest.fn().mockReturnValue({ isZero: () => true }) }),
      wallet: { publicKey: { toBase58: () => "mock" } },
      program: { programId: "mock" },
    }),
    getWallet: jest.fn().mockReturnValue({ publicKey: { toBase58: () => "mock" } }),
    getSpotPosition: jest.fn().mockReturnValue(null),
    getSpotBalance: jest.fn().mockReturnValue(new Decimal("0")),
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
