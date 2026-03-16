import Decimal from "decimal.js";
import {
  selectBestLST,
  supportsLST,
  calculateLSTYieldBoost,
  marginImpact,
  LST_REGISTRY,
} from "../strategy/lst";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("LST Module", () => {
  describe("selectBestLST", () => {
    it("returns highest effective yield LST for SOL", () => {
      const best = selectBestLST("SOL");
      expect(best).not.toBeNull();
      // JitoSOL has 7.2% APY * 0.80 weight = 5.76% effective
      // mSOL has 6.6% APY * 0.80 weight = 5.28% effective
      // bSOL has 6.5% APY * 0.78 weight = 5.07% effective
      // JitoSOL should win
      expect(best!.name).toBe("JitoSOL");
      expect(best!.spotIndex).toBe(6);
    });

    it("returns null for non-SOL assets (BTC)", () => {
      const result = selectBestLST("BTC");
      expect(result).toBeNull();
    });

    it("returns null for non-SOL assets (ETH)", () => {
      const result = selectBestLST("ETH");
      expect(result).toBeNull();
    });
  });

  describe("supportsLST", () => {
    it("returns true for SOL", () => {
      expect(supportsLST("SOL")).toBe(true);
    });

    it("returns false for BTC", () => {
      expect(supportsLST("BTC")).toBe(false);
    });

    it("returns false for ETH", () => {
      expect(supportsLST("ETH")).toBe(false);
    });
  });

  describe("calculateLSTYieldBoost", () => {
    it("computes correct daily and annual yield", () => {
      const lst = LST_REGISTRY.JitoSOL;
      const notional = new Decimal("10000"); // $10k position

      const result = calculateLSTYieldBoost(lst, notional);

      // Annual: 10000 * 0.072 = 720
      expect(result.annualYield.toFixed(2)).toBe("720.00");
      // Daily: 720 / 365.25 ≈ 1.9713
      expect(result.dailyYield.toFixed(4)).toBe("1.9713");
      // Hourly: 720 / 8766 ≈ 0.0821
      expect(result.hourlyYield.toFixed(4)).toBe("0.0821");
    });

    it("handles zero position size", () => {
      const lst = LST_REGISTRY.mSOL;
      const notional = new Decimal("0");

      const result = calculateLSTYieldBoost(lst, notional);

      expect(result.annualYield.eq(0)).toBe(true);
      expect(result.dailyYield.eq(0)).toBe(true);
      expect(result.hourlyYield.eq(0)).toBe(true);
    });

    it("handles very large position sizes", () => {
      const lst = LST_REGISTRY.JitoSOL;
      const notional = new Decimal("50000000"); // $50M position

      const result = calculateLSTYieldBoost(lst, notional);

      // Annual: 50_000_000 * 0.072 = 3_600_000
      expect(result.annualYield.toFixed(2)).toBe("3600000.00");
      // Daily should still be consistent
      expect(
        result.dailyYield.mul(365.25).toFixed(2)
      ).toBe(result.annualYield.toFixed(2));
    });
  });

  describe("marginImpact", () => {
    it("calculates correct margin drag for JitoSOL", () => {
      const lst = LST_REGISTRY.JitoSOL;
      // Raw SOL weight: 0.90, JitoSOL weight: 0.80
      // Impact = (0.90 - 0.80) / 0.80 = 0.125
      const impact = marginImpact(lst);
      expect(impact.toFixed(4)).toBe("0.1250");
    });

    it("calculates correct margin drag for bSOL", () => {
      const lst = LST_REGISTRY.bSOL;
      // Raw SOL weight: 0.90, bSOL weight: 0.78
      // Impact = (0.90 - 0.78) / 0.78 ≈ 0.1538
      const impact = marginImpact(lst);
      expect(impact.toFixed(4)).toBe("0.1538");
    });

    it("LST weight vs SOL weight — higher collateral weight means less drag", () => {
      const jitoImpact = marginImpact(LST_REGISTRY.JitoSOL);
      const bsolImpact = marginImpact(LST_REGISTRY.bSOL);

      // JitoSOL (0.80 weight) should have less margin drag than bSOL (0.78 weight)
      expect(jitoImpact.lt(bsolImpact)).toBe(true);
    });
  });
});
