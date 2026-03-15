import dotenv from "dotenv";
import Decimal from "decimal.js";

dotenv.config();

export const config = {
  // Solana
  solanaRpcUrl:
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  /** Helius RPC URL — required for getPriorityFeeEstimate in sendAndConfirmOptimisedTx */
  heliusRpcUrl:
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
  /** Path to keypair JSON file (preferred, matches ANCHOR_WALLET convention) */
  keypairPath: process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH || "",
  /** Base58-encoded private key (fallback if no keypair file) */
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || "",

  // Ranger Earn (Voltr)
  rangerApiUrl: process.env.RANGER_API_URL || "https://api.voltr.xyz",
  vaultPubkey: process.env.VAULT_PUBKEY || "",

  // Drift
  driftEnv: (process.env.DRIFT_ENV || "mainnet-beta") as
    | "mainnet-beta"
    | "devnet",
  /** Drift Data API base URL */
  driftDataApi: "https://data.api.drift.trade",

  // Binance
  binanceApiKey: process.env.BINANCE_API_KEY || "",
  binanceSecret: process.env.BINANCE_SECRET || "",
  binanceTestnet: process.env.BINANCE_TESTNET === "true",

  // Strategy
  /** "drift-only" keeps all capital on-chain (seedable by vault). "cross-venue" adds Binance perp leg. */
  strategyMode: (process.env.STRATEGY_MODE || "drift-only") as
    | "drift-only"
    | "cross-venue",
  maxLeverage: new Decimal(process.env.MAX_LEVERAGE || "2.0"),
  healthRatioFloor: new Decimal(process.env.HEALTH_RATIO_FLOOR || "1.10"),
  maxDrawdownPct: new Decimal(process.env.MAX_DRAWDOWN_PCT || "3.0"),
  /** Minimum annualized funding rate to open a position (below this, skip) */
  minFundingAPY: new Decimal(process.env.MIN_FUNDING_APY || "0.10"),
  rebalanceIntervalMs: parseInt(
    process.env.REBALANCE_INTERVAL_MS || "28800000"
  ), // 8 hours
  targetAssets: (process.env.TARGET_ASSETS || "SOL,BTC,ETH").split(","),

  // AI Agent
  fundingPredictionLookbackHours: parseInt(
    process.env.FUNDING_PREDICTION_LOOKBACK_HOURS || "168"
  ),
  regimeDetectionWindow: parseInt(
    process.env.REGIME_DETECTION_WINDOW || "48"
  ),

  // Program IDs (mainnet)
  programs: {
    drift: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
    driftVaults: "vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR",
    vaultProgram: "vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8",
    driftAdaptor: "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP",
    lendingAdaptor: "aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz",
    trustfulAdaptor: "3pnpK9nrs1R65eMV1wqCXkDkhSgN18xb1G5pgYPwoZjJ",
  },

  // AI / LLM
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "anthropic/claude-sonnet-4",

  /** Relax delta-neutrality checks for devnet (spot oracles are stale) */
  relaxDeltaChecks: process.env.RELAX_DELTA_CHECKS === "true",

  // Token mints
  mints: {
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;
