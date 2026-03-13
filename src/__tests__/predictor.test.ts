import Decimal from "decimal.js";
import { FundingPredictor } from "../strategy/predictor";
import { FundingRate } from "../strategy/types";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makeRate(
  asset: string,
  annualized: number
): FundingRate {
  return {
    asset,
    venue: "drift",
    rate: new Decimal(annualized / (24 * 365.25)),
    annualizedRate: new Decimal(annualized),
    timestamp: Date.now(),
    nextSettlement: Date.now() + 3600_000,
  };
}

describe("FundingPredictor", () => {
  let predictor: FundingPredictor;

  beforeEach(() => {
    predictor = new FundingPredictor(0.3, 168);
  });

  describe("update", () => {
    it("stores rate history per asset", () => {
      predictor.update([makeRate("SOL", 0.10)]);
      predictor.update([makeRate("SOL", 0.12)]);
      expect(predictor.getHistoryLength("SOL")).toBe(2);
    });

    it("respects max history limit", () => {
      const shortPredictor = new FundingPredictor(0.3, 5);
      for (let i = 0; i < 10; i++) {
        shortPredictor.update([makeRate("SOL", 0.10 + i * 0.01)]);
      }
      expect(shortPredictor.getHistoryLength("SOL")).toBe(5);
    });

    it("tracks multiple assets independently", () => {
      predictor.update([
        makeRate("SOL", 0.10),
        makeRate("BTC", 0.15),
      ]);
      expect(predictor.getHistoryLength("SOL")).toBe(1);
      expect(predictor.getHistoryLength("BTC")).toBe(1);
    });
  });

  describe("predict", () => {
    it("returns low confidence with insufficient data", () => {
      predictor.update([makeRate("SOL", 0.10)]);
      const prediction = predictor.predict("SOL");

      expect(prediction.confidence.lte(new Decimal("0.5"))).toBe(true);
      expect(prediction.signalStrength).toBe("weak");
    });

    it("returns higher confidence with more data", () => {
      // Feed 50 consistent positive rates
      for (let i = 0; i < 50; i++) {
        predictor.update([makeRate("SOL", 0.10 + Math.random() * 0.02)]);
      }

      const prediction = predictor.predict("SOL");

      expect(prediction.confidence.gt(new Decimal("0.5"))).toBe(true);
      expect(prediction.direction).toBe("positive");
    });

    it("predicts positive direction for positive funding history", () => {
      for (let i = 0; i < 20; i++) {
        predictor.update([makeRate("SOL", 0.12)]);
      }

      const prediction = predictor.predict("SOL");
      expect(prediction.direction).toBe("positive");
      expect(prediction.predictedRate.gt(0)).toBe(true);
    });

    it("predicts negative direction for negative funding history", () => {
      for (let i = 0; i < 20; i++) {
        predictor.update([makeRate("ETH", -0.10)]);
      }

      const prediction = predictor.predict("ETH");
      expect(prediction.direction).toBe("negative");
      expect(prediction.predictedRate.lt(0)).toBe(true);
    });

    it("classifies signal strength based on rate magnitude", () => {
      // Strong signal: high rate
      for (let i = 0; i < 20; i++) {
        predictor.update([makeRate("SOL", 0.20)]);
      }
      expect(predictor.predict("SOL").signalStrength).toBe("strong");

      // Reset and test weak signal
      predictor.reset();
      for (let i = 0; i < 20; i++) {
        predictor.update([makeRate("BTC", 0.03)]);
      }
      expect(predictor.predict("BTC").signalStrength).toBe("weak");
    });

    it("returns default prediction for unknown asset", () => {
      const prediction = predictor.predict("UNKNOWN");
      expect(prediction.confidence.eq(new Decimal("0.3"))).toBe(true);
      expect(prediction.predictedRate.eq(0)).toBe(true);
    });
  });

  describe("predictAll", () => {
    it("returns predictions sorted by confidence × |rate|", () => {
      // Feed different rates
      for (let i = 0; i < 20; i++) {
        predictor.update([
          makeRate("SOL", 0.08),
          makeRate("BTC", 0.20),
          makeRate("ETH", 0.05),
        ]);
      }

      const predictions = predictor.predictAll(["SOL", "BTC", "ETH"]);

      expect(predictions).toHaveLength(3);
      // BTC should rank first (highest |rate| with similar confidence)
      expect(predictions[0].asset).toBe("BTC");
    });
  });

  describe("cross-asset correlation", () => {
    it("uses other assets' rates to inform predictions", () => {
      // SOL and BTC have positive funding, ETH has no data
      for (let i = 0; i < 20; i++) {
        predictor.update([
          makeRate("SOL", 0.15),
          makeRate("BTC", 0.18),
        ]);
      }
      // Feed just one ETH rate
      predictor.update([makeRate("ETH", 0.05)]);

      const ethPrediction = predictor.predict("ETH");
      // ETH prediction should be influenced by SOL/BTC positive rates
      // (cross-asset signal pulls ETH positive)
      expect(ethPrediction.predictedRate.gt(new Decimal("0.02"))).toBe(true);
    });
  });

  describe("mean reversion", () => {
    it("mean reversion signal pulls below extreme rate", () => {
      // Build up normal history
      for (let i = 0; i < 30; i++) {
        predictor.update([makeRate("SOL", 0.10)]);
      }
      // Add extreme spike
      for (let i = 0; i < 5; i++) {
        predictor.update([makeRate("SOL", 0.50)]);
      }

      const prediction = predictor.predict("SOL");
      // Mean reversion signal itself should pull below the extreme rate
      expect(prediction.signals.meanReversionSignal.lt(new Decimal("0.50"))).toBe(true);
      // Overall prediction is bounded (momentum pushes up, reversion pulls down)
      expect(prediction.predictedRate.lt(new Decimal("0.70"))).toBe(true);
    });
  });

  describe("reset", () => {
    it("clears all history", () => {
      predictor.update([makeRate("SOL", 0.10)]);
      predictor.update([makeRate("BTC", 0.15)]);

      predictor.reset();

      expect(predictor.getHistoryLength("SOL")).toBe(0);
      expect(predictor.getHistoryLength("BTC")).toBe(0);
    });
  });
});
