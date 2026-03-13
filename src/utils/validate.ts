/**
 * Config validation — runs at startup to catch misconfiguration
 * before wasting RPC calls or failing mid-trade.
 */
import { config } from "../config";
import { logger } from "./logger";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateConfig(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Required for all modes ──────────────────────────────────────

  if (!config.solanaRpcUrl || config.solanaRpcUrl === "https://api.mainnet-beta.solana.com") {
    warnings.push(
      "Using default public Solana RPC — rate limits will throttle the agent. " +
        "Set SOLANA_RPC_URL to a dedicated endpoint (Helius, Triton, etc.)."
    );
  }

  if (!config.keypairPath && !config.solanaPrivateKey) {
    errors.push(
      "No wallet configured. Set ANCHOR_WALLET (keypair path) or SOLANA_PRIVATE_KEY."
    );
  }

  // Strategy parameters
  if (config.maxLeverage.lte(0) || config.maxLeverage.gt(10)) {
    errors.push(
      `MAX_LEVERAGE=${config.maxLeverage} is out of range. Must be 0 < x <= 10.`
    );
  }

  if (config.healthRatioFloor.lt(1)) {
    errors.push(
      `HEALTH_RATIO_FLOOR=${config.healthRatioFloor} is below 1.0 — positions will be liquidated.`
    );
  }

  if (config.maxDrawdownPct.lte(0) || config.maxDrawdownPct.gt(50)) {
    warnings.push(
      `MAX_DRAWDOWN_PCT=${config.maxDrawdownPct} — very high drawdown tolerance.`
    );
  }

  if (config.minFundingAPY.lt(0)) {
    errors.push("MIN_FUNDING_APY cannot be negative.");
  }

  if (config.targetAssets.length === 0) {
    errors.push("TARGET_ASSETS is empty — agent has nothing to trade.");
  }

  const validAssets = ["SOL", "BTC", "ETH"];
  for (const asset of config.targetAssets) {
    if (!validAssets.includes(asset)) {
      errors.push(
        `TARGET_ASSETS contains unsupported asset "${asset}". Supported: ${validAssets.join(", ")}`
      );
    }
  }

  if (config.rebalanceIntervalMs < 60_000) {
    errors.push(
      `REBALANCE_INTERVAL_MS=${config.rebalanceIntervalMs} is too small (<1 min). ` +
        "Minimum is 60000 (1 minute)."
    );
  }

  // ── Cross-venue mode checks ─────────────────────────────────────

  if (config.strategyMode === "cross-venue") {
    if (!config.binanceApiKey || !config.binanceSecret) {
      errors.push(
        "cross-venue mode requires BINANCE_API_KEY and BINANCE_SECRET."
      );
    }
  }

  // ── Drift environment ───────────────────────────────────────────

  if (!["mainnet-beta", "devnet"].includes(config.driftEnv)) {
    errors.push(
      `DRIFT_ENV="${config.driftEnv}" is invalid. Must be "mainnet-beta" or "devnet".`
    );
  }

  if (config.driftEnv === "devnet") {
    warnings.push(
      "Running on devnet — funding rates and liquidity differ from mainnet."
    );
  }

  // ── Hackathon constraints ───────────────────────────────────────

  if (config.healthRatioFloor.lt(1.05)) {
    warnings.push(
      "HEALTH_RATIO_FLOOR < 1.05 — hackathon rules disqualify high-leverage looping with health < 1.05."
    );
  }

  // Log results
  for (const w of warnings) {
    logger.warn(`[config] ${w}`);
  }
  for (const e of errors) {
    logger.error(`[config] ${e}`);
  }

  const valid = errors.length === 0;
  if (valid) {
    logger.info("[config] Configuration validated successfully", {
      mode: config.strategyMode,
      env: config.driftEnv,
      assets: config.targetAssets,
      maxLeverage: config.maxLeverage.toString(),
      healthFloor: config.healthRatioFloor.toString(),
      maxDrawdown: `${config.maxDrawdownPct}%`,
    });
  }

  return { valid, errors, warnings };
}
