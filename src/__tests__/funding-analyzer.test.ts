import Decimal from "decimal.js";
import { DriftFundingAnalyzer } from "../drift/funding";

// Mock config
jest.mock("../config", () => ({
  config: {
    targetAssets: ["SOL", "BTC", "ETH"],
    driftDataApi: "https://data.api.drift.trade",
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

// Mock @drift-labs/sdk constants — must match what funding.ts imports
jest.mock("@drift-labs/sdk", () => {
  const BN = require("bn.js");
  return {
    DriftClient: jest.fn(),
    convertToNumber: (bn: any, precision: any) => {
      // Simple mock: return the raw number stored in _mockValue
      if (bn && bn._mockValue !== undefined) {
        return bn._mockValue;
      }
      return 0;
    },
    PRICE_PRECISION: new BN(1e6),
    FUNDING_RATE_PRECISION: new BN(1e9),
    BN,
    PerpMarketAccount: {},
  };
});

/**
 * Helper to create a mock BN-like object that carries a value
 * for our mocked convertToNumber to extract.
 */
function mockBN(value: number) {
  const BN = require("bn.js");
  const bn = new BN(0);
  bn._mockValue = value;
  return bn;
}

function makePerpMarketAccount(opts: {
  lastFundingRate: number;
  last24HAvgFundingRate: number;
  lastMarkPriceTwap: number;
  oraclePriceTwap: number;
  baseAssetAmountLong: number;
  baseAssetAmountShort: number;
}) {
  return {
    amm: {
      lastFundingRate: mockBN(opts.lastFundingRate),
      last24HAvgFundingRate: mockBN(opts.last24HAvgFundingRate),
      lastMarkPriceTwap: mockBN(opts.lastMarkPriceTwap),
      historicalOracleData: {
        lastOraclePriceTwap: mockBN(opts.oraclePriceTwap),
      },
      baseAssetAmountLong: mockBN(opts.baseAssetAmountLong),
      baseAssetAmountShort: mockBN(opts.baseAssetAmountShort),
    },
  };
}

describe("DriftFundingAnalyzer", () => {
  let analyzer: DriftFundingAnalyzer;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      getPerpMarketAccount: jest.fn(),
    };
    analyzer = new DriftFundingAnalyzer(mockClient);
  });

  // ── analyzeFundingRate (single asset) ──────────────────────────────

  describe("analyzeFundingRate", () => {
    it("returns correct premium calculation", () => {
      // mark=105, oracle=100 → premium = (105-100)/100 = 0.05
      const market = makePerpMarketAccount({
        lastFundingRate: 0.0001,      // positive hourly rate
        last24HAvgFundingRate: 0.0001,
        lastMarkPriceTwap: 105,
        oraclePriceTwap: 100,
        baseAssetAmountLong: 1000,
        baseAssetAmountShort: -800,
      });
      mockClient.getPerpMarketAccount.mockReturnValue(market);

      const result = analyzer.analyzeFundingRate("SOL", 0);

      expect(result).not.toBeNull();
      // premium = (105-100)/100 = 0.05
      expect(result!.premium.toNumber()).toBeCloseTo(0.05, 4);
      expect(result!.asset).toBe("SOL");
      expect(result!.markTwap.toNumber()).toBeCloseTo(105, 0);
      expect(result!.oracleTwap.toNumber()).toBeCloseTo(100, 0);
    });

    it("correctly identifies attractive funding", () => {
      // Positive hourly rate → positive annualized, positive premium → attractive
      const hourlyRate = 0.00001; // annualized = 0.00001 * 24 * 365.25 = ~0.0876
      const market = makePerpMarketAccount({
        lastFundingRate: hourlyRate,
        last24HAvgFundingRate: hourlyRate,
        lastMarkPriceTwap: 101,
        oraclePriceTwap: 100,
        baseAssetAmountLong: 500,
        baseAssetAmountShort: -400,
      });
      mockClient.getPerpMarketAccount.mockReturnValue(market);

      const result = analyzer.analyzeFundingRate("SOL", 0);

      expect(result).not.toBeNull();
      // annualized = 0.00001 * 24 * 365.25 ≈ 0.0877 > 0.05 threshold
      expect(result!.annualizedRate.toNumber()).toBeGreaterThan(0.05);
      // premium > 0.0005 → predictedDirection = "positive" (not "negative")
      expect(result!.predictedDirection).not.toBe("negative");
      expect(result!.isAttractive).toBe(true);
    });

    it("returns null when market account is not found", () => {
      mockClient.getPerpMarketAccount.mockReturnValue(null);

      const result = analyzer.analyzeFundingRate("SOL", 0);
      expect(result).toBeNull();
    });

    it("identifies unattractive funding with negative rate", () => {
      // Negative rate and negative premium → shorts pay, unattractive
      const market = makePerpMarketAccount({
        lastFundingRate: -0.0001,
        last24HAvgFundingRate: -0.0001,
        lastMarkPriceTwap: 98,
        oraclePriceTwap: 100,
        baseAssetAmountLong: 300,
        baseAssetAmountShort: -700,
      });
      mockClient.getPerpMarketAccount.mockReturnValue(market);

      const result = analyzer.analyzeFundingRate("BTC", 1);

      expect(result).not.toBeNull();
      expect(result!.isAttractive).toBe(false);
    });
  });

  // ── analyzeAllAssets ───────────────────────────────────────────────

  describe("analyzeAllAssets", () => {
    it("returns analyses for all configured assets", () => {
      // Set up markets for SOL (0), BTC (1), ETH (2)
      const makeMarket = (rate: number) =>
        makePerpMarketAccount({
          lastFundingRate: rate,
          last24HAvgFundingRate: rate,
          lastMarkPriceTwap: 101,
          oraclePriceTwap: 100,
          baseAssetAmountLong: 500,
          baseAssetAmountShort: -400,
        });

      mockClient.getPerpMarketAccount.mockImplementation(
        (index: number) => {
          if (index === 0) return makeMarket(0.0002); // SOL
          if (index === 1) return makeMarket(0.0003); // BTC
          if (index === 2) return makeMarket(0.0001); // ETH
          return null;
        }
      );

      const analyses = analyzer.analyzeAllAssets();

      expect(analyses).toHaveLength(3);
      const assets = analyses.map((a) => a.asset);
      expect(assets).toContain("SOL");
      expect(assets).toContain("BTC");
      expect(assets).toContain("ETH");
    });

    it("sorts results by annualized rate descending", () => {
      const makeMarket = (rate: number) =>
        makePerpMarketAccount({
          lastFundingRate: rate,
          last24HAvgFundingRate: rate,
          lastMarkPriceTwap: 101,
          oraclePriceTwap: 100,
          baseAssetAmountLong: 500,
          baseAssetAmountShort: -400,
        });

      mockClient.getPerpMarketAccount.mockImplementation(
        (index: number) => {
          if (index === 0) return makeMarket(0.0001); // SOL - lowest
          if (index === 1) return makeMarket(0.0003); // BTC - highest
          if (index === 2) return makeMarket(0.0002); // ETH - middle
          return null;
        }
      );

      const analyses = analyzer.analyzeAllAssets();

      expect(analyses[0].asset).toBe("BTC");
      expect(analyses[1].asset).toBe("ETH");
      expect(analyses[2].asset).toBe("SOL");
    });

    it("skips assets where market account returns null", () => {
      mockClient.getPerpMarketAccount.mockImplementation(
        (index: number) => {
          if (index === 0)
            return makePerpMarketAccount({
              lastFundingRate: 0.0001,
              last24HAvgFundingRate: 0.0001,
              lastMarkPriceTwap: 101,
              oraclePriceTwap: 100,
              baseAssetAmountLong: 500,
              baseAssetAmountShort: -400,
            });
          return null; // BTC and ETH not available
        }
      );

      const analyses = analyzer.analyzeAllAssets();

      expect(analyses).toHaveLength(1);
      expect(analyses[0].asset).toBe("SOL");
    });
  });
});
