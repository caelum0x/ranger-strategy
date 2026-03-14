import Decimal from "decimal.js";
import fs from "fs";
import path from "path";
import { VaultPerformanceTracker } from "../vault/performance";
import { StrategyState } from "../strategy/types";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makeState(overrides?: Partial<StrategyState>): StrategyState {
  return {
    totalCapital: new Decimal("20"),
    deployedCapital: new Decimal("10"),
    idleCapital: new Decimal("10"),
    positions: [],
    totalPnl: new Decimal("0.50"),
    totalFundingCollected: new Decimal("0.30"),
    totalLendingCollected: new Decimal("0.05"),
    totalTradingCosts: new Decimal("0.02"),
    currentDrawdown: new Decimal("0"),
    maxDrawdownHit: new Decimal("0"),
    healthRatio: new Decimal("1.5"),
    apyEstimate: new Decimal("12"),
    lastRebalance: Date.now(),
    regime: "neutral",
    cycleCount: 5,
    directionFlips: 0,
    ...overrides,
  };
}

describe("VaultPerformanceTracker", () => {
  const navFile = path.join(process.cwd(), ".ranger-state", "nav-history.jsonl");

  afterEach(() => {
    // Clean up test NAV file
    if (fs.existsSync(navFile)) {
      fs.unlinkSync(navFile);
    }
  });

  describe("getDeployableCapital", () => {
    it("returns full idle when no withdrawals pending", () => {
      const tracker = new VaultPerformanceTracker();
      const result = tracker.getDeployableCapital(
        new Decimal("20"),
        new Decimal("10"),
        new Decimal("0")
      );

      // With 10% buffer on $20 = $2 reserved, deployable = $10 - $2 = $8
      expect(result.deployable.toNumber()).toBe(8);
      expect(result.needsReduction).toBe(false);
    });

    it("reduces deployable when withdrawals pending", () => {
      const tracker = new VaultPerformanceTracker();
      const result = tracker.getDeployableCapital(
        new Decimal("20"),
        new Decimal("10"),
        new Decimal("5")
      );

      // Reserved = max($5 withdrawals, $2 buffer) = $5, deployable = $10 - $5 = $5
      expect(result.deployable.toNumber()).toBe(5);
      expect(result.reserved.toNumber()).toBe(5);
      expect(result.needsReduction).toBe(false);
    });

    it("flags reduction needed when withdrawals exceed idle", () => {
      const tracker = new VaultPerformanceTracker();
      const result = tracker.getDeployableCapital(
        new Decimal("20"),
        new Decimal("5"),
        new Decimal("8")
      );

      // Withdrawals $8 > idle $5 — needs position reduction
      expect(result.deployable.toNumber()).toBe(0);
      expect(result.needsReduction).toBe(true);
    });

    it("never returns negative deployable", () => {
      const tracker = new VaultPerformanceTracker();
      const result = tracker.getDeployableCapital(
        new Decimal("20"),
        new Decimal("2"),
        new Decimal("15")
      );

      expect(result.deployable.gte(0)).toBe(true);
    });
  });

  describe("recordSnapshot + generateReport", () => {
    it("records snapshots and generates report", () => {
      const tracker = new VaultPerformanceTracker();
      const state = makeState();

      tracker.recordSnapshot(state, {
        totalShares: new Decimal("2000"),
        depositorCount: 3,
      });

      const report = tracker.generateReport();
      expect(report.currentNAV.toNumber()).toBe(20.5); // 20 + 0.50 PnL
      expect(report.depositorCount).toBe(3);
      expect(report.sharePrice.gt(0)).toBe(true);
    });

    it("calculates return correctly over multiple snapshots", () => {
      const tracker = new VaultPerformanceTracker();

      // First snapshot: NAV = $20
      tracker.recordSnapshot(makeState({ totalPnl: new Decimal("0") }), {
        totalShares: new Decimal("2000"),
      });

      // Second snapshot: NAV = $21 (gained $1)
      tracker.recordSnapshot(makeState({ totalPnl: new Decimal("1") }), {
        totalShares: new Decimal("2000"),
      });

      const report = tracker.generateReport();
      expect(report.totalReturn.gt(0)).toBe(true); // positive return
    });
  });

  describe("calculateDepositorEquity", () => {
    it("calculates per-depositor equity breakdown", () => {
      const tracker = new VaultPerformanceTracker();

      const depositors = [
        { authority: "depositorA", shares: new Decimal("600"), netDeposits: new Decimal("10") },
        { authority: "depositorB", shares: new Decimal("400"), netDeposits: new Decimal("8") },
      ];

      const nav = new Decimal("20");
      const equity = tracker.calculateDepositorEquity(depositors, nav);

      expect(equity).toHaveLength(2);
      // DepositorA: 600/1000 * 20 = $12
      expect(equity[0].estimatedEquity).toBe("12.0000");
      expect(equity[0].shareOfVault).toBe("60.00%");
      // DepositorB: 400/1000 * 20 = $8
      expect(equity[1].estimatedEquity).toBe("8.0000");
    });

    it("calculates depositor PnL", () => {
      const tracker = new VaultPerformanceTracker();

      const depositors = [
        { authority: "user1", shares: new Decimal("1000"), netDeposits: new Decimal("18") },
      ];

      const nav = new Decimal("20.50");
      const equity = tracker.calculateDepositorEquity(depositors, nav);

      // Deposited $18, now worth $20.50 → PnL = $2.50
      expect(equity[0].estimatedPnl).toBe("2.5000");
    });

    it("handles empty depositors", () => {
      const tracker = new VaultPerformanceTracker();
      const equity = tracker.calculateDepositorEquity([], new Decimal("20"));
      expect(equity).toHaveLength(0);
    });
  });

  describe("getNAVHistory", () => {
    it("returns empty when no snapshots exist", () => {
      const tracker = new VaultPerformanceTracker();
      expect(tracker.getNAVHistory()).toHaveLength(0);
    });

    it("returns limited history", () => {
      const tracker = new VaultPerformanceTracker();

      for (let i = 0; i < 5; i++) {
        tracker.recordSnapshot(makeState({ cycleCount: i }));
      }

      const limited = tracker.getNAVHistory(3);
      expect(limited).toHaveLength(3);
      // Should be last 3
      expect(limited[0].cycle).toBe(2);
    });
  });

  describe("formatReport", () => {
    it("formats all fields correctly", () => {
      const tracker = new VaultPerformanceTracker();
      tracker.recordSnapshot(makeState());

      const report = tracker.generateReport();
      const formatted = tracker.formatReport(report);

      expect(formatted.currentNAV).toMatch(/^\$/);
      expect(formatted.totalReturn).toMatch(/%$/);
      expect(formatted.capitalUtilization).toMatch(/%$/);
    });
  });
});
