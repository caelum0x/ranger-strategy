import { VenueHealthMonitor } from "../strategy/venue-health";

// Mock TelegramAlerter to avoid real API calls
jest.mock("../alerts/telegram", () => ({
  TelegramAlerter: jest.fn().mockImplementation(() => ({
    alert: jest.fn().mockResolvedValue(undefined),
    emergencyAlert: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe("VenueHealthMonitor", () => {
  describe("drift health tracking", () => {
    it("starts healthy", () => {
      const monitor = new VenueHealthMonitor();
      expect(monitor.getDriftStatus()).toBe("HEALTHY");
      expect(monitor.isDriftHealthy()).toBe(true);
      expect(monitor.isDriftDown()).toBe(false);
    });

    it("degrades after consecutive failures", () => {
      const monitor = new VenueHealthMonitor({
        failuresBeforeWarning: 2,
        failuresBeforeDegraded: 4,
        failuresBeforeDown: 6,
      });

      // 2 failures → WARNING
      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);
      expect(monitor.getDriftStatus()).toBe("WARNING");
      expect(monitor.isDriftHealthy()).toBe(true); // WARNING is still "healthy enough"

      // 4 failures → DEGRADED
      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);
      expect(monitor.getDriftStatus()).toBe("DEGRADED");
      expect(monitor.shouldBlockNewEntries()).toBe(true);

      // 6 failures → DOWN
      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);
      expect(monitor.getDriftStatus()).toBe("DOWN");
      expect(monitor.isDriftDown()).toBe(true);
    });

    it("recovers on successful call", () => {
      const monitor = new VenueHealthMonitor({
        failuresBeforeWarning: 2,
      });

      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);
      expect(monitor.getDriftStatus()).toBe("WARNING");

      monitor.recordDriftCall(true); // one success resets
      expect(monitor.getDriftStatus()).toBe("HEALTHY");
    });
  });

  describe("health scores", () => {
    it("returns 100 when healthy", () => {
      const monitor = new VenueHealthMonitor();
      expect(monitor.getHealthScore("drift")).toBe(100);
    });

    it("returns lower score when degraded", () => {
      const monitor = new VenueHealthMonitor({
        failuresBeforeDegraded: 2,
      });
      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);
      expect(monitor.getHealthScore("drift")).toBeLessThanOrEqual(30);
    });

    it("penalizes for stale oracles", () => {
      const monitor = new VenueHealthMonitor();
      monitor.updateOracleAge("JTO", 120); // stale
      expect(monitor.getHealthScore("drift")).toBe(90); // -10 per stale oracle
    });
  });

  describe("oracle staleness", () => {
    it("tracks stale oracles", () => {
      const monitor = new VenueHealthMonitor({ maxOracleAgeSeconds: 60 });
      monitor.updateOracleAge("SOL", 30);
      monitor.updateOracleAge("JTO", 90);

      expect(monitor.isOracleStale("SOL")).toBe(false);
      expect(monitor.isOracleStale("JTO")).toBe(true);
      expect(monitor.getStaleOracles()).toEqual(["JTO"]);
    });

    it("clears stale status on fresh update", () => {
      const monitor = new VenueHealthMonitor({ maxOracleAgeSeconds: 60 });
      monitor.updateOracleAge("JTO", 90); // stale
      expect(monitor.isOracleStale("JTO")).toBe(true);

      monitor.updateOracleAge("JTO", 10); // fresh again
      expect(monitor.isOracleStale("JTO")).toBe(false);
    });
  });

  describe("tx failure rate", () => {
    it("tracks transaction success rate", () => {
      const monitor = new VenueHealthMonitor();
      monitor.recordTxResult(true);
      monitor.recordTxResult(true);
      monitor.recordTxResult(false);

      const snapshot = monitor.getSnapshot("drift");
      expect(snapshot.recentTxFailureRate).toBeCloseTo(1 / 3, 2);
    });
  });

  describe("venue failover", () => {
    it("keeps preferred venue when healthy", () => {
      const monitor = new VenueHealthMonitor();
      const result = monitor.selectPerpVenue("drift", true);
      expect(result.venue).toBe("drift");
      expect(result.failover).toBe(false);
    });

    it("fails over to Binance when Drift is degraded", () => {
      const monitor = new VenueHealthMonitor({
        failuresBeforeDegraded: 2,
      });
      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);

      const result = monitor.selectPerpVenue("drift", true);
      expect(result.venue).toBe("binance");
      expect(result.failover).toBe(true);
    });

    it("stays on Drift if no Binance available", () => {
      const monitor = new VenueHealthMonitor({
        failuresBeforeDegraded: 2,
      });
      monitor.recordDriftCall(false);
      monitor.recordDriftCall(false);

      const result = monitor.selectPerpVenue("drift", false);
      expect(result.venue).toBe("drift");
      expect(result.failover).toBe(false);
    });
  });

  describe("snapshots", () => {
    it("provides full health snapshot", () => {
      const monitor = new VenueHealthMonitor();
      monitor.recordDriftCall(true);
      monitor.updateOracleAge("SOL", 10);

      const snapshot = monitor.getSnapshot("drift");
      expect(snapshot.venue).toBe("drift");
      expect(snapshot.status).toBe("HEALTHY");
      expect(snapshot.score).toBe(100);
      expect(snapshot.consecutiveFailures).toBe(0);
      expect(snapshot.staleOracles).toEqual([]);
    });
  });
});
