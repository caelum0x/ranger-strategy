import { BN } from "@coral-xyz/anchor";
import { VaultConfig, VaultParams, VaultConfigField } from "@voltr/vault-sdk";

// ONLY NEEDED FOR INIT VAULT
export const vaultConfig: VaultConfig = {
  maxCap: new BN(100_000_000_000), // 100K USDC (10^6 Decimals)
  startAtTs: new BN(0),
  managerPerformanceFee: 500, // 500 = 5% in basis points
  adminPerformanceFee: 500, // 500 = 5% in basis points
  managerManagementFee: 0, // 0 = 0% in basis points
  adminManagementFee: 0, // 0 = 0% in basis points
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

// ONLY NEEDED IF YOU WANT TO SET LP TOKEN METADATA
export const lpTokenMetadata = {
  symbol: "",
  name: "",
  uri: "",
};

// MAIN ASSET DEPOSITED INTO VAULT
export const assetMintAddress = "";
export const assetTokenProgram = ""; // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID

// TO FILL UP AFTER INIT VAULT
export const vaultAddress = "";

// LUT CREATED AND EXTENDED ON INITS AND UTILISED FOR DEPOSIT AND WITHDRAW STRATEGIES
export const useLookupTable = true;
// TO FILL UP IF useLookupTable IS TRUE AFTER LUT IS CREATED
export const lookupTableAddress = "";

// TAKE INTO ACCOUNT TOKEN DECIMALS 1_000_000 = 1 USDC (6 DECIMALS) LP is ALWAYS 9 DECIMALS
// ONLY NEEDED FOR DEPOSIT VAULT, WITHDRAW VAULT
export const depositAmountVault = 1_000_000;
export const withdrawAmountVault = 1_000_000;
export const isWithdrawAll = false;
export const isWithdrawInLp = false;

// FOR VAULT CONFIG UPDATES
export const vaultConfigUpdateField = VaultConfigField.MaxCap;
export const vaultConfigUpdateValue = new BN(200_000_000_000);
