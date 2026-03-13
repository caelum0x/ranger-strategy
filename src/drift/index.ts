/**
 * Drift Protocol integration module.
 *
 * Modules:
 * - client.ts    — DriftManager class (main client wrapper)
 * - funding.ts   — Funding rate analysis (on-chain + trend prediction)
 * - orders.ts    — Order helpers (delta-neutral entry/exit, stop-loss)
 * - data-api.ts  — Drift Data API client (historical rates, candles, market stats)
 * - delegate.ts  — Delegated trading setup (vault manager pattern)
 */

export { DriftManager } from "./client";
export type { DriftManagerConfig } from "./client";

export { DriftFundingAnalyzer } from "./funding";
export type { FundingAnalysis } from "./funding";

export {
  createPerpMarketOrder,
  createPerpLimitOrder,
  createSpotMarketOrder,
  createGenericOrder,
  createStopLossOrder,
  createTakeProfitOrder,
  executeDeltaNeutralEntry,
  executeDeltaNeutralExit,
  executeDeltaNeutralEntryWithStopLoss,
} from "./orders";

export { DriftExecutor } from "./executor";

export { DriftDataAPI } from "./data-api";
export type {
  FundingRateEntry,
  MarketStats,
  BorrowRateEntry,
  CandleEntry,
  TradeEntry,
} from "./data-api";

export {
  createDelegatedDriftClient,
  setupDelegate,
  enableMarginTrading,
} from "./delegate";
export type { DelegateConfig } from "./delegate";

export { DriftVaultManager } from "./vault";
export type { VaultInfo, DepositorInfo } from "./vault";
export {
  VAULT_PROGRAM_ID,
  WithdrawUnit,
  encodeName,
  decodeName,
} from "./vault";
