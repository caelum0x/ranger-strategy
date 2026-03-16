/**
 * Drift Insurance Fund Staking — additional yield source.
 *
 * Ported from drift-plugin/tools/drift.ts → stakeToDriftInsuranceFund().
 * Insurance fund staking earns:
 *   - Portion of protocol revenue (liquidation fees, trading fees)
 *   - Backstop yield when insurance fund is healthy
 *
 * Risk: insurance fund takes losses when protocol is in deficit.
 * Used alongside delta-neutral + lending for triple yield stacking.
 */
import {
  DriftClient,
  BN,
  QUOTE_PRECISION,
  MainnetSpotMarkets,
  getInsuranceFundStakeAccountPublicKey,
} from "@drift-labs/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface InsuranceFundStakeInfo {
  marketIndex: number;
  symbol: string;
  stakedAmount: number;
  ifShares: number;
  lastWithdrawRequestShares: number;
  lastWithdrawRequestValue: number;
}

// ── Insurance Fund Operations ───────────────────────────────────

/**
 * Stake tokens into Drift insurance fund for yield.
 * From: drift-plugin/tools/drift.ts → stakeToDriftInsuranceFund()
 */
export async function stakeToInsuranceFund(
  client: DriftClient,
  amount: number,
  symbol: string = "USDC"
): Promise<string> {
  const token = MainnetSpotMarkets.find(
    (v) => v.symbol === symbol.toUpperCase()
  );
  if (!token) {
    throw new Error(
      `Token ${symbol} not found. Available: ${MainnetSpotMarkets.map((v) => v.symbol).join(", ")}`
    );
  }

  const amountBN = new BN(amount * 10 ** token.precisionExp.toNumber());
  const spotMarketAccount = client.getSpotMarketAccount(token.marketIndex);

  // Check if insurance fund stake account exists
  const ifStakeAccountPublicKey = getInsuranceFundStakeAccountPublicKey(
    client.program.programId,
    client.wallet.publicKey,
    token.marketIndex
  );

  let needsInit = false;
  try {
    const accountInfo = await client.connection.getAccountInfo(
      ifStakeAccountPublicKey
    );
    needsInit = !accountInfo;
  } catch {
    needsInit = true;
  }

  if (needsInit) {
    logger.info("Initializing insurance fund stake account", {
      symbol,
      marketIndex: token.marketIndex,
    });
    await client.initializeInsuranceFundStake(token.marketIndex);
  }

  // Get the user's token account
  const userTokenAccount = getAssociatedTokenAddressSync(
    token.mint,
    client.wallet.publicKey
  );

  const txSig = await client.addInsuranceFundStake({
    marketIndex: token.marketIndex,
    amount: amountBN,
    collateralAccountPublicKey: userTokenAccount,
  } as any);

  logger.info("Staked to insurance fund", {
    symbol,
    amount,
    txSig,
  });

  return typeof txSig === "string" ? txSig : "";
}

/**
 * Request unstake from insurance fund (starts cooldown period).
 */
export async function requestUnstakeFromInsuranceFund(
  client: DriftClient,
  amount: number,
  symbol: string = "USDC"
): Promise<string> {
  const token = MainnetSpotMarkets.find(
    (v) => v.symbol === symbol.toUpperCase()
  );
  if (!token) throw new Error(`Token ${symbol} not found`);

  const amountBN = new BN(amount * 10 ** token.precisionExp.toNumber());
  const txSig = await client.requestRemoveInsuranceFundStake(
    token.marketIndex,
    amountBN
  );

  logger.info("Requested insurance fund unstake", { symbol, amount, txSig });
  return typeof txSig === "string" ? txSig : "";
}

/**
 * Complete unstake after cooldown period.
 */
export async function unstakeFromInsuranceFund(
  client: DriftClient,
  symbol: string = "USDC"
): Promise<string> {
  const token = MainnetSpotMarkets.find(
    (v) => v.symbol === symbol.toUpperCase()
  );
  if (!token) throw new Error(`Token ${symbol} not found`);

  const userTokenAccount = getAssociatedTokenAddressSync(
    token.mint,
    client.wallet.publicKey
  );

  const txSig = await client.removeInsuranceFundStake(
    token.marketIndex,
    userTokenAccount
  );

  logger.info("Completed insurance fund unstake", { symbol, txSig });
  return typeof txSig === "string" ? txSig : "";
}
