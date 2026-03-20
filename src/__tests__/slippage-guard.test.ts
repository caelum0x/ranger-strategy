import { SlippageGuard } from "../strategy/slippage-guard";

describe("SlippageGuard", () => {
  describe("tier classification", () => {
    it("classifies SOL/BTC/ETH as Tier 1", () => {
      const guard = new SlippageGuard();
      expect(guard.getTier("SOL")).toBe(1);
      expect(guard.getTier("BTC")).toBe(1);
      expect(guard.getTier("ETH")).toBe(1);
    });

    it("classifies JTO/INJ as Tier 2", () => {
      const guard = new SlippageGuard();
      expect(guard.getTier("JTO")).toBe(2);
      expect(guard.getTier("INJ")).toBe(2);
    });

    it("classifies unknown assets as Tier 2 (conservative)", () => {
      const guard = new SlippageGuard();
      expect(guard.getTier("UNKNOWN")).toBe(2);
    });

    it("respects tier overrides", () => {
      const guard = new SlippageGuard({
        tierOverrides: { JTO: 1 },
      });
      expect(guard.getTier("JTO")).toBe(1);
    });
  });

  describe("slippage limits", () => {
    it("returns lower slippage for Tier 1", () => {
      const guard = new SlippageGuard();
      expect(guard.getMaxSlippageBps("SOL")).toBe(80);
    });

    it("returns higher slippage for Tier 2", () => {
      const guard = new SlippageGuard();
      expect(guard.getMaxSlippageBps("JTO")).toBe(150);
    });

    it("uses custom limits when configured", () => {
      const guard = new SlippageGuard({
        tier1MaxSlippageBps: 50,
        tier2MaxSlippageBps: 200,
      });
      expect(guard.getMaxSlippageBps("SOL")).toBe(50);
      expect(guard.getMaxSlippageBps("JTO")).toBe(200);
    });
  });

  describe("pre-trade check", () => {
    it("always allows Tier 1 assets", async () => {
      const guard = new SlippageGuard();
      const check = await guard.checkBeforeTrade("SOL", "long", 100_000);
      expect(check.allowed).toBe(true);
      expect(check.tier).toBe(1);
    });
  });

  describe("slippage tracking", () => {
    it("records and tracks slippage per asset", () => {
      const guard = new SlippageGuard();
      guard.recordSlippage({
        timestamp: Date.now(),
        asset: "JTO",
        direction: "long",
        expectedPrice: 3.50,
        executedPrice: 3.52,
        slippageBps: 57,
        sizeUsd: 50_000,
      });
      guard.recordSlippage({
        timestamp: Date.now(),
        asset: "JTO",
        direction: "short",
        expectedPrice: 3.50,
        executedPrice: 3.48,
        slippageBps: 43,
        sizeUsd: 50_000,
      });

      expect(guard.getMeanSlippage("JTO")).toBe(50);
    });

    it("returns 0 for assets with no history", () => {
      const guard = new SlippageGuard();
      expect(guard.getMeanSlippage("SOL")).toBe(0);
    });

    it("getStats returns all tracked assets", () => {
      const guard = new SlippageGuard();
      guard.recordSlippage({
        timestamp: Date.now(),
        asset: "SOL",
        direction: "long",
        expectedPrice: 150,
        executedPrice: 150.05,
        slippageBps: 3,
        sizeUsd: 100_000,
      });
      guard.recordSlippage({
        timestamp: Date.now(),
        asset: "JTO",
        direction: "short",
        expectedPrice: 3.50,
        executedPrice: 3.48,
        slippageBps: 57,
        sizeUsd: 50_000,
      });

      const stats = guard.getStats();
      expect(stats).toHaveLength(2);
      expect(stats.find((s) => s.asset === "SOL")?.tier).toBe(1);
      expect(stats.find((s) => s.asset === "JTO")?.tier).toBe(2);
    });

    it("limits history to configured size", () => {
      const guard = new SlippageGuard({ historySize: 3 });
      for (let i = 0; i < 10; i++) {
        guard.recordSlippage({
          timestamp: Date.now(),
          asset: "SOL",
          direction: "long",
          expectedPrice: 150,
          executedPrice: 150 + i * 0.01,
          slippageBps: i,
          sizeUsd: 100_000,
        });
      }
      const stats = guard.getStats();
      expect(stats.find((s) => s.asset === "SOL")?.fillCount).toBe(3);
    });
  });
});
