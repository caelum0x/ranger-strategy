import dotenv from "dotenv";
import Decimal from "decimal.js";

dotenv.config();

function parseIntegerList(value: string | undefined, fallback: number[]): number[] {
  if (!value || !value.trim()) {
    return fallback;
  }

  return value
    .split(",")
    .map((entry) => parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));
}

function parseMarketSubaccountMap(
  value: string | undefined
): Record<number, number> {
  const result: Record<number, number> = {};
  if (!value || !value.trim()) {
    return result;
  }

  for (const pair of value.split(",")) {
    const [marketIndexRaw, subaccountIdRaw] = pair.split(":");
    const marketIndex = parseInt((marketIndexRaw || "").trim(), 10);
    const subaccountId = parseInt((subaccountIdRaw || "").trim(), 10);
    if (Number.isFinite(marketIndex) && Number.isFinite(subaccountId)) {
      result[marketIndex] = subaccountId;
    }
  }

  return result;
}

export const config = {
  // Solana
  solanaRpcUrl:
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
  /** Helius RPC URL — required for getPriorityFeeEstimate in sendAndConfirmOptimisedTx */
  heliusRpcUrl:
    process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
  /** Websocket endpoint for account subscriptions */
  heliusWssUrl:
    process.env.HELIUS_WSS_URL ||
    process.env.SOLANA_WSS_URL ||
    (process.env.HELIUS_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      "https://api.mainnet-beta.solana.com").replace(/^http/, "ws"),
  /** Path to keypair JSON file (preferred, matches ANCHOR_WALLET convention) */
  keypairPath: process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH || "",
  /** Base58-encoded private key (fallback if no keypair file) */
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || "",

  // Ranger Earn (Voltr)
  rangerApiUrl: process.env.RANGER_API_URL || "https://api.voltr.xyz",
  vaultPubkey: process.env.VAULT_PUBKEY || "",
  strategyPubkey: process.env.STRATEGY_PUBKEY || "",
  heliusApiKey: process.env.HELIUS_API_KEY || "",
  webhookUrl: process.env.WEBHOOK_URL || "",
  webhookPort: parseInt(process.env.PORT || process.env.WEBHOOK_PORT || "3000"),
  webhookPath: process.env.WEBHOOK_PATH || "/webhook",
  indexerStorePath:
    process.env.INDEXER_STORE_PATH || ".ranger-state/indexer-state.json",
  sorApiKey: process.env.SOR_API_KEY || "",
  sorApiBaseUrl:
    process.env.SOR_API_BASE_URL ||
    "https://staging-sor-api-437363704888.asia-northeast1.run.app/v1",
  sorDataApiBaseUrl:
    process.env.SOR_DATA_API_BASE_URL ||
    "https://data-api-staging-437363704888.asia-northeast1.run.app/v1",

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
  strategyProfile: (process.env.STRATEGY_PROFILE || "driftbear-neutral-farmer") as
    | "generic"
    | "driftbear-neutral-farmer",
  driftBearNeutralAllocation: new Decimal(
    process.env.DRIFTBEAR_NEUTRAL_ALLOCATION || "0.50"
  ),
  driftBearTopAssetOnly: process.env.DRIFTBEAR_TOP_ASSET_ONLY !== "false",
  maxLeverage: new Decimal(process.env.MAX_LEVERAGE || "2.0"),
  healthRatioFloor: new Decimal(process.env.HEALTH_RATIO_FLOOR || "1.10"),
  maxDrawdownPct: new Decimal(process.env.MAX_DRAWDOWN_PCT || "3.0"),
  /** Minimum annualized funding rate to open a position (below this, skip) */
  minFundingAPY: new Decimal(process.env.MIN_FUNDING_APY || "0.10"),
  rebalanceIntervalMs: parseInt(
    process.env.REBALANCE_INTERVAL_MS || "28800000"
  ), // 8 hours
  jupiterSwapSlippageBps: parseInt(
    process.env.JUPITER_SWAP_SLIPPAGE_BPS || "100"
  ),
  targetAssets: (process.env.TARGET_ASSETS || "SOL,BTC,ETH").split(","),
  oracleMaxConfidenceBps: parseInt(
    process.env.ORACLE_MAX_CONFIDENCE_BPS || "50"
  ),
  oracleMaxSpreadBps: parseInt(process.env.ORACLE_MAX_SPREAD_BPS || "50"),
  oracleSizeFloor: new Decimal(process.env.ORACLE_SIZE_FLOOR || "0.4"),
  oracleSkipMultiplier: new Decimal(
    process.env.ORACLE_SKIP_MULTIPLIER || "2.5"
  ),
  liquidationScanIntervalMs: parseInt(
    process.env.LIQUIDATION_SCAN_INTERVAL_MS || "5000"
  ),
  liquidationMaxUsersPerTick: parseInt(
    process.env.LIQUIDATION_MAX_USERS_PER_TICK || "5"
  ),
  liquidationTakeoverPct: parseFloat(
    process.env.LIQUIDATION_TAKEOVER_PCT || "0.25"
  ),
  liquidationAutoDerisk: process.env.LIQUIDATION_AUTO_DERISK !== "false",
  liquidationDryRun: process.env.LIQUIDATION_DRY_RUN === "true",
  liquidationSubaccounts: parseIntegerList(
    process.env.LIQUIDATION_SUBACCOUNTS,
    [0]
  ),
  liquidationDefaultSubaccountId: parseInt(
    process.env.LIQUIDATION_DEFAULT_SUBACCOUNT_ID || "0"
  ),
  liquidationPerpSubaccountMap: parseMarketSubaccountMap(
    process.env.LIQUIDATION_PERP_SUBACCOUNT_MAP
  ),
  liquidationSpotSubaccountMap: parseMarketSubaccountMap(
    process.env.LIQUIDATION_SPOT_SUBACCOUNT_MAP
  ),
  liquidationPriorityFeeMultiplier: parseFloat(
    process.env.LIQUIDATION_PRIORITY_FEE_MULTIPLIER || "1.2"
  ),
  liquidationMaxPriorityFeeMicroLamports: parseInt(
    process.env.LIQUIDATION_MAX_PRIORITY_FEE_MICROLAMPORTS || "250000"
  ),
  liquidationFallbackPriorityFeeMicroLamports: parseInt(
    process.env.LIQUIDATION_FALLBACK_PRIORITY_FEE_MICROLAMPORTS || "50000"
  ),
  liquidationComputeUnits: parseInt(
    process.env.LIQUIDATION_COMPUTE_UNITS || "1400000"
  ),

  // Jito MEV Protection
  jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || "",

  // Yellowstone gRPC
  yellowstoneGrpcEndpoint: process.env.YELLOWSTONE_GRPC_ENDPOINT || "",
  yellowstoneGrpcToken: process.env.YELLOWSTONE_GRPC_TOKEN || "",

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
    driftbearCustomAdaptor:
      process.env.DRIFTBEAR_CUSTOM_ADAPTOR_PROGRAM ||
      "4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ",
    lendingAdaptor: "aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz",
    trustfulAdaptor: "3pnpK9nrs1R65eMV1wqCXkDkhSgN18xb1G5pgYPwoZjJ",
  },

  // AI / LLM
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "anthropic/claude-3-sonnet-20240229",

  /** Relax delta-neutrality checks for devnet (spot oracles are stale) */
  relaxDeltaChecks: process.env.RELAX_DELTA_CHECKS === "true",

  // Capital Ramp
  /** Number of days to ramp from 10% to 100% deployment (0 = disabled) */
  capitalRampDays: parseInt(process.env.CAPITAL_RAMP_DAYS || "10"),
  /** Disable ramp and deploy full capital immediately */
  capitalRampDisabled: process.env.CAPITAL_RAMP_DISABLED === "true",

  // Slippage Guard
  /** Tier 1 (SOL/BTC/ETH) max slippage in bps */
  tier1MaxSlippageBps: parseInt(process.env.TIER1_MAX_SLIPPAGE_BPS || "80"),
  /** Tier 2 (JTO/INJ/etc.) max slippage in bps */
  tier2MaxSlippageBps: parseInt(process.env.TIER2_MAX_SLIPPAGE_BPS || "150"),
  /** Tier 2 max fraction of DLOB depth per order */
  tier2MaxDepthFraction: parseFloat(process.env.TIER2_MAX_DEPTH_FRACTION || "0.15"),

  // Venue Health
  /** Drift RPC timeout in ms */
  venueRpcTimeoutMs: parseInt(process.env.VENUE_RPC_TIMEOUT_MS || "10000"),
  /** Max oracle age in seconds before flagging venue health */
  venueMaxOracleAgeSeconds: parseInt(process.env.VENUE_MAX_ORACLE_AGE_SECONDS || "60"),

  // Token mints
  mints: {
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;
