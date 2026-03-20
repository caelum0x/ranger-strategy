/**
 * Venue health monitor — tracks Drift uptime and triggers failover actions.
 *
 * Monitors:
 *   - Drift RPC responsiveness (connection health)
 *   - Oracle freshness (per-asset staleness)
 *   - Transaction success rate (recent tx failures)
 *
 * When Drift health degrades:
 *   1. WARNING: Log + alert, continue with caution
 *   2. DEGRADED: Block new positions, keep existing ones
 *   3. DOWN: Trip circuit breaker, attempt emergency hedging on Binance
 *
 * This is NOT a replacement for the circuit breaker — it adds a venue-specific
 * health dimension that the breaker doesn't cover (the breaker checks risk
 * metrics, this checks infrastructure health).
 */
import { logger } from "../utils/logger";
import { TelegramAlerter } from "../alerts/telegram";
import { config } from "../config";

// ── Types ───────────────────────────────────────────────────────

export type VenueStatus = "HEALTHY" | "WARNING" | "DEGRADED" | "DOWN";

export interface VenueHealthConfig {
  /** RPC timeout in milliseconds */
  rpcTimeoutMs: number;
  /** Max oracle age in seconds before flagging */
  maxOracleAgeSeconds: number;
  /** Check interval in milliseconds */
  checkIntervalMs: number;
  /** Number of consecutive failures before status downgrade */
  failuresBeforeWarning: number;
  failuresBeforeDegraded: number;
  failuresBeforeDown: number;
  /** Tx failure rate (0-1) over recent window to trigger warning */
  txFailureRateThreshold: number;
  /** Number of recent txs to track */
  txHistorySize: number;
}

const DEFAULT_CONFIG: VenueHealthConfig = {
  rpcTimeoutMs: 10_000,
  maxOracleAgeSeconds: 60,
  checkIntervalMs: 30_000,
  failuresBeforeWarning: 2,
  failuresBeforeDegraded: 5,
  failuresBeforeDown: 10,
  txFailureRateThreshold: 0.5,
  txHistorySize: 20,
};

export interface VenueHealthSnapshot {
  venue: string;
  status: VenueStatus;
  score: number; // 0-100
  lastCheckMs: number;
  consecutiveFailures: number;
  recentTxFailureRate: number;
  staleOracles: string[];
  details: string;
}

// ── Venue Health Monitor ────────────────────────────────────────

export class VenueHealthMonitor {
  private config: VenueHealthConfig;
  private telegram: TelegramAlerter;

  // Drift state
  private driftConsecutiveFailures: number = 0;
  private driftLastCheck: number = 0;
  private driftLastHealthy: number = Date.now();
  private driftStatus: VenueStatus = "HEALTHY";

  // Binance state
  private binanceConsecutiveFailures: number = 0;
  private binanceLastCheck: number = 0;
  private binanceStatus: VenueStatus = "HEALTHY";

  // Tx tracking
  private recentTxResults: Array<{ success: boolean; timestamp: number }> = [];

  // Oracle tracking
  private oracleAges: Map<string, number> = new Map();
  private staleOracles: Set<string> = new Set();

  constructor(healthConfig: Partial<VenueHealthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...healthConfig };
    this.telegram = new TelegramAlerter();
  }

  // ── Health Checks ─────────────────────────────────────────────

  /**
   * Record a Drift RPC call result. Call this after every RPC interaction.
   */
  recordDriftCall(success: boolean): void {
    if (success) {
      this.driftConsecutiveFailures = 0;
    } else {
      this.driftConsecutiveFailures++;
    }
    this.driftLastCheck = Date.now();
    this.updateDriftStatus();
  }

  /**
   * Record a Binance API call result.
   */
  recordBinanceCall(success: boolean): void {
    if (success) {
      this.binanceConsecutiveFailures = 0;
    } else {
      this.binanceConsecutiveFailures++;
    }
    this.binanceLastCheck = Date.now();
    this.updateBinanceStatus();
  }

  /**
   * Record a transaction result (success/failure) for rate tracking.
   */
  recordTxResult(success: boolean): void {
    this.recentTxResults.push({ success, timestamp: Date.now() });
    if (this.recentTxResults.length > this.config.txHistorySize) {
      this.recentTxResults.shift();
    }
  }

  /**
   * Update oracle age for an asset. Call each cycle with fresh oracle data.
   */
  updateOracleAge(asset: string, ageSeconds: number): void {
    this.oracleAges.set(asset, ageSeconds);
    if (ageSeconds > this.config.maxOracleAgeSeconds) {
      if (!this.staleOracles.has(asset)) {
        this.staleOracles.add(asset);
        logger.warn(
          `Venue health: ${asset} oracle stale (${ageSeconds}s > ${this.config.maxOracleAgeSeconds}s)`
        );
      }
    } else {
      this.staleOracles.delete(asset);
    }
  }

  // ── Status Queries ────────────────────────────────────────────

  /**
   * Get current Drift health status.
   */
  getDriftStatus(): VenueStatus {
    return this.driftStatus;
  }

  /**
   * Get current Binance health status.
   */
  getBinanceStatus(): VenueStatus {
    return this.binanceStatus;
  }

  /**
   * Is Drift healthy enough for new positions?
   */
  isDriftHealthy(): boolean {
    return this.driftStatus === "HEALTHY" || this.driftStatus === "WARNING";
  }

  /**
   * Is Drift too unhealthy — should we stop trading entirely?
   */
  isDriftDown(): boolean {
    return this.driftStatus === "DOWN";
  }

  /**
   * Should we block new entries on Drift? (DEGRADED or DOWN)
   */
  shouldBlockNewEntries(): boolean {
    return (
      this.driftStatus === "DEGRADED" || this.driftStatus === "DOWN"
    );
  }

  /**
   * Is Binance available as a failover venue?
   */
  isBinanceAvailable(): boolean {
    return (
      this.binanceStatus === "HEALTHY" || this.binanceStatus === "WARNING"
    );
  }

  /**
   * Get a health score (0-100) for a venue.
   */
  getHealthScore(venue: "drift" | "binance"): number {
    const status = venue === "drift" ? this.driftStatus : this.binanceStatus;
    const consecutiveFailures =
      venue === "drift"
        ? this.driftConsecutiveFailures
        : this.binanceConsecutiveFailures;

    const statusScores: Record<VenueStatus, number> = {
      HEALTHY: 100,
      WARNING: 70,
      DEGRADED: 30,
      DOWN: 0,
    };

    let score = statusScores[status];

    // Penalize for stale oracles (Drift only)
    if (venue === "drift" && this.staleOracles.size > 0) {
      score -= this.staleOracles.size * 10;
    }

    // Penalize for tx failure rate
    const txFailRate = this.getTxFailureRate();
    if (txFailRate > 0.2) {
      score -= Math.round(txFailRate * 30);
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get full health snapshot for monitoring/logging.
   */
  getSnapshot(venue: "drift" | "binance"): VenueHealthSnapshot {
    const isDrift = venue === "drift";
    return {
      venue,
      status: isDrift ? this.driftStatus : this.binanceStatus,
      score: this.getHealthScore(venue),
      lastCheckMs: isDrift ? this.driftLastCheck : this.binanceLastCheck,
      consecutiveFailures: isDrift
        ? this.driftConsecutiveFailures
        : this.binanceConsecutiveFailures,
      recentTxFailureRate: this.getTxFailureRate(),
      staleOracles: isDrift ? Array.from(this.staleOracles) : [],
      details: isDrift
        ? `Drift: ${this.driftStatus} (${this.driftConsecutiveFailures} consecutive failures, ` +
          `${this.staleOracles.size} stale oracles, tx fail rate: ${(this.getTxFailureRate() * 100).toFixed(0)}%)`
        : `Binance: ${this.binanceStatus} (${this.binanceConsecutiveFailures} consecutive failures)`,
    };
  }

  /**
   * Get assets with stale oracles (should be excluded from trading).
   */
  getStaleOracles(): string[] {
    return Array.from(this.staleOracles);
  }

  /**
   * Check if a specific asset's oracle is stale.
   */
  isOracleStale(asset: string): boolean {
    return this.staleOracles.has(asset);
  }

  // ── Failover Logic ────────────────────────────────────────────

  /**
   * Determine the best perp venue for a new order.
   * If Drift is degraded and Binance is available, suggest Binance.
   */
  selectPerpVenue(
    preferredVenue: "drift" | "binance",
    hasBinance: boolean
  ): { venue: "drift" | "binance"; failover: boolean; reason: string } {
    // If no Binance configured, Drift is the only option
    if (!hasBinance) {
      return {
        venue: "drift",
        failover: false,
        reason: this.driftStatus === "HEALTHY"
          ? "Drift healthy"
          : `Drift ${this.driftStatus} but no failover available`,
      };
    }

    // If Drift is healthy, use preferred venue
    if (this.isDriftHealthy()) {
      return { venue: preferredVenue, failover: false, reason: "Venues healthy" };
    }

    // Drift degraded — failover to Binance if available
    if (this.shouldBlockNewEntries() && this.isBinanceAvailable()) {
      logger.warn(
        `Venue failover: Drift ${this.driftStatus} → routing perp to Binance`
      );
      return {
        venue: "binance",
        failover: true,
        reason: `Drift ${this.driftStatus} — failover to Binance`,
      };
    }

    // Both venues degraded — return preferred with warning
    return {
      venue: preferredVenue,
      failover: false,
      reason: `Both venues degraded (Drift: ${this.driftStatus}, Binance: ${this.binanceStatus})`,
    };
  }

  // ── Internal ──────────────────────────────────────────────────

  private getTxFailureRate(): number {
    if (this.recentTxResults.length === 0) return 0;
    const failures = this.recentTxResults.filter((r) => !r.success).length;
    return failures / this.recentTxResults.length;
  }

  private updateDriftStatus(): void {
    const prev = this.driftStatus;
    const f = this.driftConsecutiveFailures;

    if (f >= this.config.failuresBeforeDown) {
      this.driftStatus = "DOWN";
    } else if (f >= this.config.failuresBeforeDegraded) {
      this.driftStatus = "DEGRADED";
    } else if (f >= this.config.failuresBeforeWarning) {
      this.driftStatus = "WARNING";
    } else {
      this.driftStatus = "HEALTHY";
      this.driftLastHealthy = Date.now();
    }

    // Log status transitions
    if (prev !== this.driftStatus) {
      const msg = `Venue health: Drift ${prev} → ${this.driftStatus} (${f} consecutive failures)`;
      if (
        this.driftStatus === "DOWN" ||
        this.driftStatus === "DEGRADED"
      ) {
        logger.error(msg);
        this.telegram
          .alert(
            this.driftStatus === "DOWN" ? "critical" : "warn",
            msg
          )
          .catch(() => {});
      } else {
        logger.info(msg);
      }
    }
  }

  private updateBinanceStatus(): void {
    const prev = this.binanceStatus;
    const f = this.binanceConsecutiveFailures;

    if (f >= this.config.failuresBeforeDown) {
      this.binanceStatus = "DOWN";
    } else if (f >= this.config.failuresBeforeDegraded) {
      this.binanceStatus = "DEGRADED";
    } else if (f >= this.config.failuresBeforeWarning) {
      this.binanceStatus = "WARNING";
    } else {
      this.binanceStatus = "HEALTHY";
    }

    if (prev !== this.binanceStatus) {
      logger.info(
        `Venue health: Binance ${prev} → ${this.binanceStatus} (${f} consecutive failures)`
      );
    }
  }
}
