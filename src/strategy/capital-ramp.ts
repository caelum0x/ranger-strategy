/**
 * Phased capital deployment manager.
 *
 * Instead of deploying all capital at once, ramps in gradually over a
 * configurable period. This validates fills, slippage, and funding impact
 * at each tier before scaling up.
 *
 * Ramp schedule (default 10 days):
 *   Day 0-1:  10% of total capital
 *   Day 1-3:  25%
 *   Day 3-5:  50%
 *   Day 5-7:  75%
 *   Day 7-10: 100%
 *
 * The ramp can accelerate if performance is positive, or pause if the
 * circuit breaker trips.
 */
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

export interface RampConfig {
  /** Total days to reach full deployment (default 10) */
  rampDays: number;
  /** Ramp tiers as [dayThreshold, maxDeploymentFraction] pairs */
  tiers: Array<{ day: number; fraction: number }>;
  /** If cumulative PnL > this fraction, skip to next tier early */
  accelerationThreshold: number;
  /** If true, ramp is disabled and full capital is available immediately */
  disabled: boolean;
}

const DEFAULT_RAMP_CONFIG: RampConfig = {
  rampDays: 10,
  tiers: [
    { day: 0, fraction: 0.10 },  // Day 0-1:  10%  ($50K of $500K)
    { day: 1, fraction: 0.25 },  // Day 1-3:  25%  ($125K)
    { day: 3, fraction: 0.50 },  // Day 3-5:  50%  ($250K)
    { day: 5, fraction: 0.75 },  // Day 5-7:  75%  ($375K)
    { day: 7, fraction: 1.00 },  // Day 7-10: 100% ($500K)
  ],
  accelerationThreshold: 0.005, // +0.5% PnL → accelerate
  disabled: false,
};

export class CapitalRampManager {
  private config: RampConfig;
  private startTime: number;
  private currentTierIndex: number = 0;
  private manuallyAdvanced: boolean = false;

  constructor(config: Partial<RampConfig> = {}) {
    this.config = { ...DEFAULT_RAMP_CONFIG, ...config };
    this.startTime = Date.now();

    // Sort tiers by day ascending
    this.config.tiers.sort((a, b) => a.day - b.day);
  }

  /**
   * Get the maximum fraction of total capital that can be deployed right now.
   * Apply this as a multiplier to position sizes.
   */
  getDeploymentFraction(cumulativePnLFraction?: number): number {
    if (this.config.disabled || this.manuallyAdvanced) {
      return 1.0;
    }

    const elapsedDays = (Date.now() - this.startTime) / (24 * 3600 * 1000);

    // Find current tier based on elapsed time
    let fraction = this.config.tiers[0].fraction;
    for (const tier of this.config.tiers) {
      if (elapsedDays >= tier.day) {
        fraction = tier.fraction;
      } else {
        break;
      }
    }

    // Acceleration: if PnL is strong, bump to next tier early
    if (
      cumulativePnLFraction !== undefined &&
      cumulativePnLFraction > this.config.accelerationThreshold
    ) {
      const currentIdx = this.config.tiers.findIndex(
        (t) => t.fraction === fraction
      );
      if (currentIdx >= 0 && currentIdx < this.config.tiers.length - 1) {
        const nextFraction = this.config.tiers[currentIdx + 1].fraction;
        logger.info(
          `Capital ramp: accelerating ${(fraction * 100).toFixed(0)}% → ${(nextFraction * 100).toFixed(0)}% ` +
            `(PnL ${(cumulativePnLFraction * 100).toFixed(2)}% > ${(this.config.accelerationThreshold * 100).toFixed(1)}% threshold)`
        );
        fraction = nextFraction;
      }
    }

    return fraction;
  }

  /**
   * Apply the ramp to a deployable capital amount.
   * Returns the capped amount that should actually be used for position sizing.
   */
  applyRamp(
    totalCapital: Decimal,
    cumulativePnLFraction?: number
  ): { capped: Decimal; fraction: number } {
    const fraction = this.getDeploymentFraction(cumulativePnLFraction);
    const capped = totalCapital.mul(fraction);
    return { capped, fraction };
  }

  /**
   * Get current ramp status for logging/monitoring.
   */
  getStatus(): {
    elapsedDays: number;
    currentFraction: number;
    currentTier: string;
    fullyDeployed: boolean;
  } {
    if (this.config.disabled || this.manuallyAdvanced) {
      return {
        elapsedDays: 0,
        currentFraction: 1.0,
        currentTier: "FULL (ramp disabled)",
        fullyDeployed: true,
      };
    }

    const elapsedDays = (Date.now() - this.startTime) / (24 * 3600 * 1000);
    const fraction = this.getDeploymentFraction();
    const fullyDeployed = fraction >= 1.0;

    return {
      elapsedDays: Math.round(elapsedDays * 10) / 10,
      currentFraction: fraction,
      currentTier: `${(fraction * 100).toFixed(0)}%`,
      fullyDeployed,
    };
  }

  /**
   * Skip the ramp entirely (e.g., for experienced operators).
   */
  skipRamp(): void {
    this.manuallyAdvanced = true;
    logger.info("Capital ramp: manually skipped — full capital available");
  }

  /**
   * Reset the ramp timer (e.g., after a circuit breaker trip).
   */
  resetTimer(): void {
    this.startTime = Date.now();
    this.manuallyAdvanced = false;
    logger.info("Capital ramp: timer reset — starting ramp from tier 1");
  }
}
