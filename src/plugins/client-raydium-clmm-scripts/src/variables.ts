import { BN } from "@coral-xyz/anchor";
import { VaultConfig, VaultParams } from "@voltr/vault-sdk";
import { ORACLE } from "./constants/global";

// ONLY NEEDED FOR INIT VAULT
export const vaultConfig: VaultConfig = {
  maxCap: new BN(100_000_000_000), // 100K USDC (10^6 Decimals)
  startAtTs: new BN(0),
  managerPerformanceFee: 500, // 500 = 5% in basis points
  adminPerformanceFee: 500, // 500 = 5% in basis points
  managerManagementFee: 0, // management fee not yet implemented
  adminManagementFee: 0, // management fee not yet implemented
  lockedProfitDegradationDuration: new BN(0), // profit will be realised linearly over time (seconds)
  redemptionFee: 0, // one time fee when withdrawing
  issuanceFee: 0, // one time fee when depositing
  withdrawalWaitingPeriod: new BN(0), // waiting period before withdrawing
};

// ONLY NEEDED FOR INIT VAULT
export const vaultParams: VaultParams = {
  config: vaultConfig,
  name: "",
  description: "",
};

// ONLY NEEDED FOR INIT VAULT, INIT STRATEGIES, INIT DIRECT WITHDRAWS
export const adminFilePath = "/path/to/admin.json";
// ONLY NEEDED FOR DEPOSIT STRATEGY, WITHDRAW STRATEGY
export const managerFilePath = "/path/to/manager.json";
// ONLY NEEDED FOR DEPOSIT VAULT, WITHDRAW VAULT, DIRECT WITHDRAW STRATEGY
export const userFilePath = "/path/to/user.json";

export const heliusRpcUrl =
  "https://mainnet.helius-rpc.com/?api-key=53cef249-171a-44f5-bdae-af78a98e42dc";

// MAIN ASSET DEPOSITED INTO VAULT
export const assetMintAddress = ORACLE.USDC.MINT;
export const assetTokenProgram = ORACLE.USDC.PROGRAM_ID; // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
export const assetTokenOracle = ORACLE.USDC.PYTH_PULL_ORACLE;

// TO FILL UP AFTER INIT VAULT
export const vaultAddress = "";

// LUT CREATED AND EXTENDED ON INITS AND UTILISED FOR DEPOSIT AND WITHDRAW STRATEGIES
export const useLookupTable = true;
// TO FILL UP IF useLookupTable IS TRUE AFTER LUT IS CREATED
export const lookupTableAddress = "";

// TAKE INTO ACCOUNT TOKEN DECIMALS 1_000_000 = 1 USDC (6 DECIMALS) LP is ALWAYS 9 DECIMALS
// ONLY NEEDED FOR DEPOSIT VAULT, WITHDRAW VAULT
export const depositAssetAmountVault = 1_000_000;
export const withdrawAssetAmountVault = 1_000_000;
export const withdrawLpAmountVault = 1_000_000;

// ASSET-OUTPUT PAIR SPECIFICS (IN THIS CASE WE ARE LPING USDC-USDS POOL)
export const outputMintAddress = ORACLE.USDS.MINT;
export const outputTokenProgram = ORACLE.USDS.PROGRAM_ID;
export const outputTokenOracle = ORACLE.USDS.PYTH_PULL_ORACLE;

// POOL SPECIFICS
export const poolId = "";
export const startPrice = 0.99; // x OUTPUT PER 1 ASSET
export const endPrice = 1.01; // x OUTPUT PER 1 ASSET

// JUP SWAP SPECIFICS
export const JUP_SWAP_SLIPPAGE_BPS = 100; // 1%
export const JUP_SWAP_MAX_ACCOUNTS = 20;

// TAKE INTO ACCOUNT TOKEN DECIMALS 100_000 = 0.1 USDC (6 DECIMALS) LP is ALWAYS 9 DECIMALS
// ONLY NEEDED FOR INCREASE LIQUIDITY, DECREASE LIQUIDITY
export const increaseLiquidityAssetAmount = 100_000;
export const decreaseLiquidityAssetAmount = 100_000;
