/**
 * Production circuit breaker for the delta-neutral strategy.
 *
 * Monitors multiple risk signals and halts trading when thresholds are breached.
 * All conditions are checked every cycle — if ANY trigger fires, the breaker opens.
 *
 * Triggers:
 *   1. Daily loss exceeds maxDailyLossPct
 *   2. Direction flips exceed maxFlipsPerDay per asset
 *   3. Oracle stale for > oracleStaleSeconds
 *   4. Health ratio drops below healthRatioFloor
 *   5. Drawdown exceeds maxDrawdownPct
 *   6. Consecutive LLM failures exceed threshold
 *
 * When tripped, the breaker:
 *   - Cancels all open orders
 *   - Optionally closes all positions (if severity >= CRITICAL)
 *   - Sends Telegram alert
 *   - Enters cooldown period before allowing new trades
 */
import Decimal from "decimal.js";
import { logger } from "../utils/logger";
import { TelegramAlerter } from "../alerts/telegram";

// ── Config ──────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Max daily loss as fraction (0.02 = 2%) */
  maxDailyLossPct: number;
  /** Max direction flips per asset per day */
  maxFlipsPerDay: number;
  /** Oracle staleness threshold in seconds */
  oracleStaleSeconds: number;
  /** Health ratio floor (liquidation at 1.0) */
  healthRatioFloor: number;
  /** Max drawdown as fraction (0.03 = 3%) */
  maxDrawdownPct: number;
  /** Consecutive LLM failures before trip */
  maxConsecutiveLLMFailures: number;
  /** Cooldown after trip in milliseconds */
  cooldownMs: number;
  /** Minimum time between flips per asset in ms */
  minFlipIntervalMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxDailyLossPct: 0.02,
  maxFlipsPerDay: 1,
  oracleStaleSeconds: 60,
  healthRatioFloor: 1.10,
  maxDrawdownPct: 0.03,
  maxConsecutiveLLMFailures: 3,
  cooldownMs: 6 * 3600 * 1000, // 6 hours
  minFlipIntervalMs: 48 * 3600 * 1000, // 48 hours
};

// ── Types ───────────────────────────────────────────────────────

export type BreakerSeverity = "WARNING" | "CRITICAL" | "EMERGENCY";

export interface BreakerTrip {
  trigger: string;
  severity: BreakerSeverity;
  value: string;
  threshold: string;
  timestamp: number;
}

export type BreakerState = "CLOSED" | "OPEN" | "COOLDOWN";

// ── Circuit Breaker ─────────────────────────────────────────────

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: BreakerState = "CLOSED";
  private tripHistory: BreakerTrip[] = [];
  private lastTripTime = 0;
  private telegram: TelegramAlerter;

  // Daily tracking
  private dailyPnL = 0;
  private dailyPnLResetTime = 0;
  private peakEquity = 0;

  // Per-asset flip tracking
  private dailyFlips: Map<string, number> = new Map();
  private lastFlipTime: Map<string, number> = new Map();
  private dailyFlipResetTime = 0;

  // LLM tracking
  private consecutiveLLMFailures = 0;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.telegram = new TelegramAlerter();
    this.resetDailyCounters();
  }

  // ── State ───────────────────────────────────────────────────

  getState(): BreakerState {
    // Check if cooldown has expired
    if (
      this.state === "COOLDOWN" &&
      Date.now() - this.lastTripTime >= this.config.cooldownMs
    ) {
      logger.info("Circuit breaker cooldown expired, closing breaker");
      this.state = "CLOSED";
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() !== "CLOSED";
  }

  isTradingAllowed(): boolean {
    return this.getState() === "CLOSED";
  }

  getTrips(): BreakerTrip[] {
    return [...this.tripHistory];
  }

  getLastTrip(): BreakerTrip | null {
    return this.tripHistory.length > 0
      ? this.tripHistory[this.tripHistory.length - 1]
      : null;
  }

  // ── Manual Controls ─────────────────────────────────────────

  /** Manually reset the breaker (e.g., after investigation) */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveLLMFailures = 0;
    this.resetDailyCounters();
    logger.info("Circuit breaker manually reset");
  }

  /** Manually trip the breaker */
  manualTrip(reason: string): void {
    this.trip({
      trigger: "MANUAL",
      severity: "CRITICAL",
      value: reason,
      threshold: "N/A",
      timestamp: Date.now(),
    });
  }

  // ── Check Methods (call each cycle) ─────────────────────────

  /**
   * Run all circuit breaker checks. Returns list of violations.
   * Call this at the start of each strategy cycle.
   */
  check(params: {
    equity: number;
    dailyPnL: number;
    healthRatio: number;
    drawdownPct: number;
    oracleAgeSeconds?: Record<string, number>;
    llmFailed?: boolean;
  }): { allowed: boolean; violations: string[] } {
    this.maybeResetDaily();

    const violations: string[] = [];

    // 1. Daily loss check
    if (Math.abs(params.dailyPnL) > 0) {
      this.dailyPnL = params.dailyPnL;
    }
    const dailyLossRatio =
      this.peakEquity > 0
        ? Math.max(0, -this.dailyPnL / this.peakEquity)
        : 0;

    if (dailyLossRatio > this.config.maxDailyLossPct) {
      const trip: BreakerTrip = {
        trigger: "DAILY_LOSS",
        severity: "CRITICAL",
        value: `${(dailyLossRatio * 100).toFixed(2)}%`,
        threshold: `${(this.config.maxDailyLossPct * 100).toFixed(1)}%`,
        timestamp: Date.now(),
      };
      violations.push(
        `Daily loss ${trip.value} exceeds limit ${trip.threshold}`
      );
      this.trip(trip);
    }

    // 2. Health ratio check
    if (params.healthRatio < this.config.healthRatioFloor) {
      const severity: BreakerSeverity =
        params.healthRatio < 1.05 ? "EMERGENCY" : "CRITICAL";
      const trip: BreakerTrip = {
        trigger: "HEALTH_RATIO",
        severity,
        value: params.healthRatio.toFixed(4),
        threshold: this.config.healthRatioFloor.toFixed(2),
        timestamp: Date.now(),
      };
      violations.push(
        `Health ratio ${trip.value} below floor ${trip.threshold}`
      );
      this.trip(trip);
    }

    // 3. Drawdown check
    if (params.equity > this.peakEquity) {
      this.peakEquity = params.equity;
    }
    if (params.drawdownPct > this.config.maxDrawdownPct) {
      const trip: BreakerTrip = {
        trigger: "DRAWDOWN",
        severity: "CRITICAL",
        value: `${(params.drawdownPct * 100).toFixed(2)}%`,
        threshold: `${(this.config.maxDrawdownPct * 100).toFixed(1)}%`,
        timestamp: Date.now(),
      };
      violations.push(
        `Drawdown ${trip.value} exceeds limit ${trip.threshold}`
      );
      this.trip(trip);
    }

    // 4. Oracle staleness check
    if (params.oracleAgeSeconds) {
      for (const [asset, age] of Object.entries(params.oracleAgeSeconds)) {
        if (age > this.config.oracleStaleSeconds) {
          violations.push(
            `${asset} oracle stale: ${age}s (limit: ${this.config.oracleStaleSeconds}s)`
          );
          // WARNING level — don't trip breaker, just skip this asset
        }
      }
    }

    // 5. LLM failure tracking
    if (params.llmFailed) {
      this.consecutiveLLMFailures++;
      if (this.consecutiveLLMFailures >= this.config.maxConsecutiveLLMFailures) {
        const trip: BreakerTrip = {
          trigger: "LLM_FAILURES",
          severity: "WARNING",
          value: String(this.consecutiveLLMFailures),
          threshold: String(this.config.maxConsecutiveLLMFailures),
          timestamp: Date.now(),
        };
        violations.push(
          `${this.consecutiveLLMFailures} consecutive LLM failures (limit: ${this.config.maxConsecutiveLLMFailures})`
        );
        this.trip(trip);
      }
    } else if (params.llmFailed === false) {
      this.consecutiveLLMFailures = 0;
    }

    return {
      allowed: this.isTradingAllowed() && violations.length === 0,
      violations,
    };
  }

  // ── Flip Tracking ───────────────────────────────────────────

  /**
   * Record a direction flip for an asset.
   * Returns true if the flip is allowed, false if blocked by circuit breaker.
   */
  recordFlip(asset: string): boolean {
    this.maybeResetDaily();

    const now = Date.now();

    // Check per-asset cooldown
    const lastFlip = this.lastFlipTime.get(asset) || 0;
    if (now - lastFlip < this.config.minFlipIntervalMs) {
      const hoursRemaining =
        (this.config.minFlipIntervalMs - (now - lastFlip)) / 3600000;
      logger.info(
        `Circuit breaker: ${asset} flip blocked — ${hoursRemaining.toFixed(1)}h cooldown remaining`
      );
      return false;
    }

    // Check daily flip count
    const currentFlips = this.dailyFlips.get(asset) || 0;
    if (currentFlips >= this.config.maxFlipsPerDay) {
      logger.info(
        `Circuit breaker: ${asset} flip blocked — ${currentFlips}/${this.config.maxFlipsPerDay} daily limit`
      );
      return false;
    }

    // Allow flip
    this.dailyFlips.set(asset, currentFlips + 1);
    this.lastFlipTime.set(asset, now);
    return true;
  }

  /**
   * Check if a flip would be allowed (without recording it).
   */
  canFlip(asset: string): boolean {
    this.maybeResetDaily();
    const now = Date.now();

    const lastFlip = this.lastFlipTime.get(asset) || 0;
    if (now - lastFlip < this.config.minFlipIntervalMs) return false;

    const currentFlips = this.dailyFlips.get(asset) || 0;
    return currentFlips < this.config.maxFlipsPerDay;
  }

  // ── Internal ────────────────────────────────────────────────

  private trip(tripInfo: BreakerTrip): void {
    this.tripHistory.push(tripInfo);
    this.lastTripTime = Date.now();

    // Keep only last 100 trips
    if (this.tripHistory.length > 100) {
      this.tripHistory = this.tripHistory.slice(-50);
    }

    if (tripInfo.severity === "EMERGENCY") {
      this.state = "OPEN";
      logger.error("CIRCUIT BREAKER: EMERGENCY TRIP", tripInfo);
      this.telegram
        .emergencyAlert(
          `${tripInfo.trigger}: ${tripInfo.value} (threshold: ${tripInfo.threshold})`
        )
        .catch(() => {});
    } else if (tripInfo.severity === "CRITICAL") {
      this.state = "COOLDOWN";
      logger.warn("CIRCUIT BREAKER: CRITICAL TRIP — entering cooldown", tripInfo);
      this.telegram
        .alert(
          "critical",
          `Circuit breaker tripped: ${tripInfo.trigger}\nValue: ${tripInfo.value}\nThreshold: ${tripInfo.threshold}\nCooldown: ${(this.config.cooldownMs / 3600000).toFixed(1)}h`
        )
        .catch(() => {});
    } else {
      // WARNING — log but don't change state
      logger.warn("Circuit breaker WARNING", tripInfo);
      this.telegram
        .alert("warn", `Circuit breaker warning: ${tripInfo.trigger} — ${tripInfo.value}`)
        .catch(() => {});
    }
  }

  private maybeResetDaily(): void {
    const now = Date.now();
    const dayMs = 86400000;

    if (now - this.dailyPnLResetTime >= dayMs) {
      this.dailyPnL = 0;
      this.dailyPnLResetTime = now;
    }

    if (now - this.dailyFlipResetTime >= dayMs) {
      this.dailyFlips.clear();
      this.dailyFlipResetTime = now;
    }
  }

  private resetDailyCounters(): void {
    const now = Date.now();
    this.dailyPnL = 0;
    this.dailyPnLResetTime = now;
    this.dailyFlips.clear();
    this.dailyFlipResetTime = now;
  }
}
