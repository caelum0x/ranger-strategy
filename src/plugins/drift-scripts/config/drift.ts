import { DRIFT } from "../src/constants/drift";

export const depositStrategyAmount = 1_000_000;
export const withdrawStrategyAmount = 1_000_000;

// DRIFT VARIABLES: ONLY MAIN MARKET SUPPORTED, CHANGE AND ALIGN TO ASSET TOKEN
export const driftMarketIndex = DRIFT.SPOT.USDC.MARKET_INDEX;
export const enableMarginTrading = false;

// DIRECT WITHDRAW
export const directWithdrawDiscriminator: number[] = [];
