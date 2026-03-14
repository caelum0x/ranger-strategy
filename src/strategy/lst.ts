/**
 * LST Yield Stacking Module
 *
 * Instead of buying raw SOL spot as the hedge leg of a delta-neutral trade,
 * buy a Liquid Staking Token (JitoSOL, mSOL, bSOL) that earns ~6-7% staking APY
 * while sitting as cross-collateral on Drift.
 *
 * Triple yield: staking APY + funding rate + Drift lending yield
 *
 * Drift cross-collateral weights LSTs at ~80-85%, so margin impact is minimal
 * compared to holding raw SOL.
 */
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

export interface LSTConfig {
  /** Human-readable name */
  name: string;
  /** Drift spot market index */
  spotIndex: number;
  /** Underlying asset this LST tracks (SOL) */
  underlying: string;
  /** Approximate annual staking APY (updated periodically) */
  stakingAPY: Decimal;
  /** Drift cross-collateral weight (0-1) */
  collateralWeight: Decimal;
  /** Mint address on mainnet */
  mint: string;
}

/**
 * Known LSTs on Drift Protocol (mainnet spot market indices).
 * Drift lists these as separate spot markets with cross-collateral support.
 */
export const LST_REGISTRY: Record<string, LSTConfig> = {
  JitoSOL: {
    name: "JitoSOL",
    spotIndex: 6,
    underlying: "SOL",
    stakingAPY: new Decimal("0.072"), // ~7.2% APY
    collateralWeight: new Decimal("0.80"),
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  },
  mSOL: {
    name: "mSOL",
    spotIndex: 7,
    underlying: "SOL",
    stakingAPY: new Decimal("0.066"), // ~6.6% APY
    collateralWeight: new Decimal("0.80"),
    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  },
  bSOL: {
    name: "bSOL",
    spotIndex: 15,
    underlying: "SOL",
    stakingAPY: new Decimal("0.065"), // ~6.5% APY
    collateralWeight: new Decimal("0.78"),
    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  },
};

/**
 * Select the best LST for a given underlying asset.
 * Ranks by risk-adjusted yield: stakingAPY * collateralWeight
 * (higher collateral weight = less margin drag = more effective yield)
 */
export function selectBestLST(underlying: string): LSTConfig | null {
  const candidates = Object.values(LST_REGISTRY).filter(
    (lst) => lst.underlying === underlying
  );

  if (candidates.length === 0) return null;

  // Sort by effective yield: stakingAPY * collateralWeight
  candidates.sort((a, b) => {
    const aScore = a.stakingAPY.mul(a.collateralWeight);
    const bScore = b.stakingAPY.mul(b.collateralWeight);
    return bScore.sub(aScore).toNumber();
  });

  const best = candidates[0];
  logger.info(`Best LST for ${underlying}: ${best.name}`, {
    stakingAPY: `${best.stakingAPY.mul(100).toFixed(1)}%`,
    collateralWeight: best.collateralWeight.toFixed(2),
    effectiveYield: `${best.stakingAPY.mul(best.collateralWeight).mul(100).toFixed(1)}%`,
  });

  return best;
}

/**
 * Calculate the additional yield from using an LST vs raw spot.
 * This is the "stacking" premium — pure alpha over a basic basis trade.
 */
export function calculateLSTYieldBoost(
  lst: LSTConfig,
  positionNotional: Decimal
): { annualYield: Decimal; dailyYield: Decimal; hourlyYield: Decimal } {
  const annualYield = positionNotional.mul(lst.stakingAPY);
  const dailyYield = annualYield.div(365.25);
  const hourlyYield = annualYield.div(8766);

  return { annualYield, dailyYield, hourlyYield };
}

/**
 * Check if an asset supports LST stacking.
 * Currently only SOL has liquid staking tokens on Drift.
 */
export function supportsLST(asset: string): boolean {
  return Object.values(LST_REGISTRY).some((lst) => lst.underlying === asset);
}

/**
 * Calculate the margin impact of using an LST vs raw spot.
 * LSTs have lower collateral weight, so they provide less margin per dollar.
 * Returns the additional margin required as a fraction (e.g., 0.20 = 20% more).
 */
export function marginImpact(lst: LSTConfig): Decimal {
  // Raw SOL has ~0.90 collateral weight on Drift
  const rawWeight = new Decimal("0.90");
  // Margin drag = (rawWeight - lstWeight) / lstWeight
  return rawWeight.sub(lst.collateralWeight).div(lst.collateralWeight);
}
