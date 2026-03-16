import Decimal from "decimal.js";
import { BN } from "@drift-labs/sdk";
import {
  deriveExecutionPricingPlan,
  decimalPriceToBN,
  ExecutionPricingInput,
} from "../utils/execution-pricing";

describe("Execution Pricing", () => {
  describe("deriveExecutionPricingPlan", () => {
    it("returns correct limit price for long (price adjusted upward)", () => {
      const plan = deriveExecutionPricingPlan({
        side: "long",
        oraclePrice: new Decimal("100"),
        fallbackSlippageBps: 30,
      });

      // Long: oraclePrice * (10000 + 30) / 10000 = 100 * 1.003 = 100.30
      expect(plan.limitPrice.toFixed(2)).toBe("100.30");
      expect(plan.slippageBps).toBe(30);
    });

    it("returns correct limit price for short (price adjusted downward)", () => {
      const plan = deriveExecutionPricingPlan({
        side: "short",
        oraclePrice: new Decimal("100"),
        fallbackSlippageBps: 30,
      });

      // Short: oraclePrice * (10000 - 30) / 10000 = 100 * 0.997 = 99.70
      expect(plan.limitPrice.toFixed(2)).toBe("99.70");
      expect(plan.slippageBps).toBe(30);
    });

    it("throws on zero oracle price", () => {
      expect(() =>
        deriveExecutionPricingPlan({
          side: "long",
          oraclePrice: new Decimal("0"),
          fallbackSlippageBps: 30,
        })
      ).toThrow("Invalid oracle price");
    });

    it("throws on negative oracle price", () => {
      expect(() =>
        deriveExecutionPricingPlan({
          side: "short",
          oraclePrice: new Decimal("-50"),
          fallbackSlippageBps: 30,
        })
      ).toThrow("Invalid oracle price");
    });

    it("handles very small oracle spread via quotedPrice", () => {
      const plan = deriveExecutionPricingPlan({
        side: "long",
        oraclePrice: new Decimal("185.00"),
        fallbackSlippageBps: 30,
        quotedPrice: new Decimal("185.01"), // ~0.5 bps spread
      });

      // Spread is ~0.5 bps, plus 50 bps auction buffer = ~51 bps
      // max(fallback=30, spreadBps + 50) => max(30, 51) = 51, capped at 250
      expect(plan.slippageBps).toBeGreaterThanOrEqual(50);
      // Limit price should be at least the quoted price for a long
      expect(plan.limitPrice.gte(new Decimal("185.01"))).toBe(true);
    });

    it("handles very large oracle spread (>1%) and caps at maxSlippage", () => {
      const plan = deriveExecutionPricingPlan({
        side: "long",
        oraclePrice: new Decimal("100"),
        fallbackSlippageBps: 30,
        quotedPrice: new Decimal("102"), // 200 bps spread
      });

      // Spread = 200 bps, + 50 buffer = 250, capped at default max 250
      expect(plan.slippageBps).toBe(250);
    });

    it("price includes auction buffer (50bps) when using quotedPrice", () => {
      const plan = deriveExecutionPricingPlan({
        side: "long",
        oraclePrice: new Decimal("100"),
        fallbackSlippageBps: 10,
        quotedPrice: new Decimal("100.10"), // 10 bps spread
      });

      // oracleSpreadBps = ceil(10) = 10
      // slippageBps = min(250, max(10, 10 + 50)) = 60
      expect(plan.slippageBps).toBe(60);
      expect(plan.oracleSpreadBps).toBe(10);
    });

    it("respects custom maxSlippageBps", () => {
      const plan = deriveExecutionPricingPlan({
        side: "long",
        oraclePrice: new Decimal("100"),
        fallbackSlippageBps: 30,
        quotedPrice: new Decimal("103"), // 300 bps spread
        maxSlippageBps: 100,
      });

      // Spread 300 + buffer 50 = 350, capped at custom max 100
      expect(plan.slippageBps).toBe(100);
    });

    it("uses oracleSpreadBps when provided directly", () => {
      const plan = deriveExecutionPricingPlan({
        side: "short",
        oraclePrice: new Decimal("185"),
        fallbackSlippageBps: 20,
        oracleSpreadBps: 40,
      });

      // slippageBps = min(250, max(20, 40 + 50)) = 90
      expect(plan.slippageBps).toBe(90);
      expect(plan.oracleSpreadBps).toBe(40);
    });

    it("uses oracleConfidenceBps when provided", () => {
      const plan = deriveExecutionPricingPlan({
        side: "long",
        oraclePrice: new Decimal("185"),
        fallbackSlippageBps: 20,
        oracleConfidenceBps: 80,
      });

      // slippageBps = min(250, max(20, 80 + 50)) = 130
      expect(plan.slippageBps).toBe(130);
      expect(plan.oracleConfidenceBps).toBe(80);
    });
  });

  describe("decimalPriceToBN", () => {
    it("converts a whole number price correctly", () => {
      const result = decimalPriceToBN(new Decimal("100"));
      // 100 * 1e6 = 100_000_000
      expect(result.eq(new BN(100_000_000))).toBe(true);
    });

    it("converts a fractional price correctly", () => {
      const result = decimalPriceToBN(new Decimal("185.50"));
      // 185.50 * 1e6 = 185_500_000
      expect(result.eq(new BN(185_500_000))).toBe(true);
    });

    it("converts a very small price correctly", () => {
      const result = decimalPriceToBN(new Decimal("0.001"));
      // 0.001 * 1e6 = 1000
      expect(result.eq(new BN(1000))).toBe(true);
    });

    it("converts a large price correctly", () => {
      const result = decimalPriceToBN(new Decimal("98000"));
      // 98000 * 1e6 = 98_000_000_000
      expect(result.eq(new BN("98000000000"))).toBe(true);
    });
  });
});
