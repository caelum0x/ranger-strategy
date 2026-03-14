import Decimal from "decimal.js";
import { StrategyAdvisor, LLMStrategyAdvice } from "../ai/strategy-advisor";
import { OpenRouterClient } from "../ai/openrouter";
import { FundingRate, StrategyState } from "../strategy/types";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock config
jest.mock("../config", () => ({
  config: {
    openRouterApiKey: "test-key",
    llmModel: "test-model",
    targetAssets: ["SOL", "ETH"],
    minFundingAPY: new (require("decimal.js"))("0.05"),
  },
}));

function makeState(overrides?: Partial<StrategyState>): StrategyState {
  return {
    totalCapital: new Decimal("20"),
    deployedCapital: new Decimal("0"),
    idleCapital: new Decimal("20"),
    positions: [],
    totalPnl: new Decimal("0"),
    totalFundingCollected: new Decimal("0"),
    totalLendingCollected: new Decimal("0"),
    totalTradingCosts: new Decimal("0"),
    currentDrawdown: new Decimal("0"),
    maxDrawdownHit: new Decimal("0"),
    healthRatio: new Decimal("999"),
    apyEstimate: new Decimal("0"),
    lastRebalance: 0,
    regime: "neutral",
    cycleCount: 0,
    directionFlips: 0,
    ...overrides,
  };
}

function makeRates(): FundingRate[] {
  return [
    {
      asset: "SOL",
      venue: "drift",
      rate: new Decimal("0.003"),
      annualizedRate: new Decimal("0.26"),
      timestamp: Date.now(),
      nextSettlement: Date.now() + 3600000,
    },
    {
      asset: "ETH",
      venue: "drift",
      rate: new Decimal("-0.001"),
      annualizedRate: new Decimal("-0.075"),
      timestamp: Date.now(),
      nextSettlement: Date.now() + 3600000,
    },
  ];
}

const MOCK_LLM_RESPONSE: LLMStrategyAdvice = {
  regime: "neutral",
  regimeReasoning: "Mixed signals across assets",
  predictions: [
    {
      asset: "SOL",
      predictedRateAnnualized: 0.2,
      confidence: 0.6,
      direction: "positive",
      signalStrength: "moderate",
      reasoning: "Strong positive funding",
    },
    {
      asset: "ETH",
      predictedRateAnnualized: -0.05,
      confidence: 0.7,
      direction: "negative",
      signalStrength: "weak",
      reasoning: "Mild negative funding",
    },
  ],
  decisions: [
    {
      asset: "SOL",
      action: "open",
      perpSide: "short",
      allocationFraction: 0.4,
      reasoning: "Attractive funding rate",
    },
    {
      asset: "ETH",
      action: "skip",
      perpSide: "long",
      allocationFraction: 0,
      reasoning: "Below threshold",
    },
  ],
  portfolioReasoning: "Focus on SOL opportunity",
};

describe("StrategyAdvisor", () => {
  let mockClient: jest.Mocked<OpenRouterClient>;
  let advisor: StrategyAdvisor;

  beforeEach(() => {
    mockClient = {
      chat: jest.fn(),
      chatJSON: jest.fn().mockResolvedValue(MOCK_LLM_RESPONSE),
    } as any;
    advisor = new StrategyAdvisor(mockClient);
  });

  describe("analyze", () => {
    it("returns LLM advice with regime, predictions, and decisions", async () => {
      const result = await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      expect(result.regime).toBe("neutral");
      expect(result.predictions).toHaveLength(2);
      expect(result.decisions).toHaveLength(2);
      expect(result.portfolioReasoning).toBeTruthy();
    });

    it("validates and clamps allocation fractions", async () => {
      const badAdvice = {
        ...MOCK_LLM_RESPONSE,
        decisions: [
          { asset: "SOL", action: "open" as const, perpSide: "short" as const, allocationFraction: 0.9, reasoning: "too much" },
          { asset: "ETH", action: "skip" as const, perpSide: "long" as const, allocationFraction: -0.1, reasoning: "negative" },
        ],
      };
      mockClient.chatJSON.mockResolvedValue(badAdvice);

      const result = await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      // Should be clamped to [0, 0.5]
      expect(result.decisions[0].allocationFraction).toBeLessThanOrEqual(0.5);
      expect(result.decisions[1].allocationFraction).toBeGreaterThanOrEqual(0);
    });

    it("validates and clamps confidence", async () => {
      const badAdvice = {
        ...MOCK_LLM_RESPONSE,
        predictions: [
          { asset: "SOL", predictedRateAnnualized: 0.2, confidence: 1.5, direction: "positive" as const, signalStrength: "strong" as const, reasoning: "over-confident" },
          { asset: "ETH", predictedRateAnnualized: -0.05, confidence: 0, direction: "negative" as const, signalStrength: "weak" as const, reasoning: "zero" },
        ],
      };
      mockClient.chatJSON.mockResolvedValue(badAdvice);

      const result = await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      expect(result.predictions[0].confidence).toBeLessThanOrEqual(0.95);
      expect(result.predictions[1].confidence).toBeGreaterThanOrEqual(0.1);
    });

    it("adds missing assets to predictions and decisions", async () => {
      const partialAdvice = {
        ...MOCK_LLM_RESPONSE,
        predictions: [MOCK_LLM_RESPONSE.predictions[0]], // only SOL
        decisions: [MOCK_LLM_RESPONSE.decisions[0]], // only SOL
      };
      mockClient.chatJSON.mockResolvedValue(partialAdvice);

      const result = await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      expect(result.predictions.find((p) => p.asset === "ETH")).toBeTruthy();
      expect(result.decisions.find((d) => d.asset === "ETH")).toBeTruthy();
    });

    it("falls back to heuristics on LLM error", async () => {
      mockClient.chatJSON.mockRejectedValue(new Error("API down"));

      const result = await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      expect(result.regime).toBe("neutral");
      expect(result.regimeReasoning).toContain("LLM unavailable");
      expect(result.predictions).toHaveLength(2);
    });

    it("caches advice within 5-minute window", async () => {
      // First call
      await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      // Second call — should use cache
      await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      // chatJSON should only be called once
      expect(mockClient.chatJSON).toHaveBeenCalledTimes(1);
    });

    it("fixes invalid regime values", async () => {
      const badRegime = {
        ...MOCK_LLM_RESPONSE,
        regime: "invalid_regime" as any,
      };
      mockClient.chatJSON.mockResolvedValue(badRegime);

      const result = await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      expect(result.regime).toBe("neutral");
    });
  });

  describe("toFundingPredictions", () => {
    it("converts LLM predictions to FundingPrediction interface", () => {
      const predictions = advisor.toFundingPredictions(MOCK_LLM_RESPONSE);

      expect(predictions).toHaveLength(2);
      expect(predictions[0].asset).toBe("SOL");
      expect(predictions[0].predictedRate.toNumber()).toBe(0.2);
      expect(predictions[0].confidence.toNumber()).toBe(0.6);
      expect(predictions[0].direction).toBe("positive");
      expect(predictions[0].signalStrength).toBe("moderate");
    });
  });

  describe("getLastReasoning", () => {
    it("returns null before any analysis", () => {
      expect(advisor.getLastReasoning()).toBeNull();
    });

    it("returns formatted reasoning after analysis", async () => {
      await advisor.analyze({
        fundingRates: makeRates(),
        positions: [],
        state: makeState(),
        targetAssets: ["SOL", "ETH"],
      });

      const reasoning = advisor.getLastReasoning();
      expect(reasoning).toContain("Market Regime: neutral");
      expect(reasoning).toContain("SOL");
      expect(reasoning).toContain("ETH");
      expect(reasoning).toContain("Portfolio");
    });
  });
});
