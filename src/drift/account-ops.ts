/**
 * Drift account operations — create, query, deposit, withdraw.
 *
 * Ported from drift-plugin/tools/drift.ts:
 *   - createDriftUserAccount
 *   - doesUserHaveDriftAccount
 *   - driftUserAccountInfo
 *   - depositToDriftUserAccount
 *   - withdrawFromDriftUserAccount
 *   - getAvailableDriftSpotMarkets
 *   - getAvailableDriftPerpMarkets
 *   - swapSpotToken (Jupiter integration)
 *
 * These are essential account management operations that the strategy
 * needs for proper initialization and capital management.
 */
import {
  DriftClient,
  BN,
  QUOTE_PRECISION,
  PRICE_PRECISION,
  BASE_PRECISION,
  MainnetSpotMarkets,
  MainnetPerpMarkets,
  convertToNumber,
  numberToSafeBN,
  isVariant,
  getUserAccountPublicKeySync,
  getTokenAmount,
  JupiterClient,
} from "@drift-labs/sdk";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { logger } from "../utils/logger";
import Decimal from "decimal.js";

// ── Account Queries ─────────────────────────────────────────────

/**
 * Check if a user has a Drift account.
 * From: drift-plugin → doesUserHaveDriftAccount()
 */
export function doesUserHaveDriftAccount(
  client: DriftClient,
  authority?: PublicKey
): boolean {
  try {
    const pubkey = authority || client.wallet.publicKey;
    const userAccountKey = getUserAccountPublicKeySync(
      client.program.programId,
      pubkey,
      0
    );
    const user = client.getUser(0);
    return !!user;
  } catch {
    return false;
  }
}

/**
 * Get full Drift user account info (positions, balances, PnL).
 * From: drift-plugin → driftUserAccountInfo()
 */
export function getDriftUserAccountInfo(client: DriftClient): {
  perpPositions: Array<{
    marketIndex: number;
    baseAssetAmount: number;
    quoteAssetAmount: number;
    unrealizedPnl: number;
    symbol: string;
  }>;
  spotPositions: Array<{
    marketIndex: number;
    balance: number;
    symbol: string;
    balanceType: string;
  }>;
  totalCollateral: number;
  freeCollateral: number;
  leverage: number;
  health: number;
} {
  const user = client.getUser();
  const account = user.getUserAccount();

  const perpPositions = user.getActivePerpPositions().map((p) => {
    const market = MainnetPerpMarkets.find(
      (m) => m.marketIndex === p.marketIndex
    );
    return {
      marketIndex: p.marketIndex,
      baseAssetAmount: convertToNumber(p.baseAssetAmount, BASE_PRECISION),
      quoteAssetAmount: convertToNumber(p.quoteAssetAmount, QUOTE_PRECISION),
      unrealizedPnl: convertToNumber(
        user.getUnrealizedPNL(true, p.marketIndex),
        QUOTE_PRECISION
      ),
      symbol: market?.symbol || `PERP-${p.marketIndex}`,
    };
  });

  const spotPositions = user.getActiveSpotPositions().map((p) => {
    const market = client.getSpotMarketAccount(p.marketIndex);
    const spotMarketInfo = MainnetSpotMarkets.find(
      (m) => m.marketIndex === p.marketIndex
    );
    const amount = market
      ? getTokenAmount(p.scaledBalance, market, p.balanceType)
      : new BN(0);
    return {
      marketIndex: p.marketIndex,
      balance: convertToNumber(amount, market?.decimals ? new BN(10).pow(new BN(market.decimals)) : QUOTE_PRECISION),
      symbol: spotMarketInfo?.symbol || `SPOT-${p.marketIndex}`,
      balanceType: isVariant(p.balanceType, "deposit") ? "deposit" : "borrow",
    };
  });

  return {
    perpPositions,
    spotPositions,
    totalCollateral: convertToNumber(
      user.getTotalCollateral(),
      QUOTE_PRECISION
    ),
    freeCollateral: convertToNumber(
      user.getFreeCollateral(),
      QUOTE_PRECISION
    ),
    leverage: convertToNumber(user.getLeverage(), new BN(10000)) / 100,
    health: convertToNumber(
      user.getHealth(),
      new BN(100)
    ),
  };
}

// ── Market Info ──────────────────────────────────────────────────

/**
 * Get all available spot markets on Drift.
 * From: drift-plugin → getAvailableDriftSpotMarkets()
 */
export function getAvailableSpotMarkets(): Array<{
  marketIndex: number;
  symbol: string;
  mint: string;
}> {
  return MainnetSpotMarkets.map((m) => ({
    marketIndex: m.marketIndex,
    symbol: m.symbol,
    mint: m.mint.toBase58(),
  }));
}

/**
 * Get all available perp markets on Drift.
 * From: drift-plugin → getAvailableDriftPerpMarkets()
 */
export function getAvailablePerpMarkets(): Array<{
  marketIndex: number;
  symbol: string;
  baseAssetSymbol: string;
}> {
  return MainnetPerpMarkets.map((m) => ({
    marketIndex: m.marketIndex,
    symbol: m.symbol,
    baseAssetSymbol: m.baseAssetSymbol,
  }));
}

// ── Deposit / Withdraw ──────────────────────────────────────────

/**
 * Deposit collateral to Drift user account.
 * From: drift-plugin → depositToDriftUserAccount()
 */
export async function depositToDriftAccount(
  client: DriftClient,
  amount: number,
  marketIndex: number = 0, // 0 = USDC
  subAccountId?: number
): Promise<string> {
  const token = MainnetSpotMarkets.find((m) => m.marketIndex === marketIndex);
  if (!token) throw new Error(`Spot market ${marketIndex} not found`);

  const amountBN = numberToSafeBN(amount, token.precision);

  const txSig = await client.deposit(
    amountBN,
    marketIndex,
    undefined, // userTokenAccount (auto-resolved)
    subAccountId
  );

  logger.info("Deposited to Drift account", {
    amount,
    symbol: token.symbol,
    marketIndex,
    txSig,
  });

  return typeof txSig === "string" ? txSig : "";
}

/**
 * Withdraw from Drift user account.
 * From: drift-plugin → withdrawFromDriftUserAccount()
 */
export async function withdrawFromDriftAccount(
  client: DriftClient,
  amount: number,
  marketIndex: number = 0,
  subAccountId?: number
): Promise<string> {
  const token = MainnetSpotMarkets.find((m) => m.marketIndex === marketIndex);
  if (!token) throw new Error(`Spot market ${marketIndex} not found`);

  const amountBN = numberToSafeBN(amount, token.precision);

  const txSig = await client.withdraw(
    amountBN,
    marketIndex,
    undefined,
    undefined,
    subAccountId
  );

  logger.info("Withdrew from Drift account", {
    amount,
    symbol: token.symbol,
    marketIndex,
    txSig,
  });

  return typeof txSig === "string" ? txSig : "";
}

// ── Jupiter Swap ────────────────────────────────────────────────

/**
 * Swap tokens via Jupiter through Drift.
 * From: drift-plugin → swapSpotToken()
 *
 * Supports ExactIn (specify fromAmount) and ExactOut (specify toAmount).
 */
export async function swapSpotToken(
  client: DriftClient,
  params: {
    fromSymbol: string;
    toSymbol: string;
    fromAmount?: number;
    toAmount?: number;
    slippage?: number; // percentage, default 0.5
  }
): Promise<string> {
  const fromToken = MainnetSpotMarkets.find(
    (v) => v.symbol === params.fromSymbol.toUpperCase()
  );
  const toToken = MainnetSpotMarkets.find(
    (v) => v.symbol === params.toSymbol.toUpperCase()
  );

  if (!fromToken) {
    throw new Error(
      `Token ${params.fromSymbol} not found. Available: ${MainnetSpotMarkets.map((v) => v.symbol).join(", ")}`
    );
  }
  if (!toToken) {
    throw new Error(
      `Token ${params.toSymbol} not found. Available: ${MainnetSpotMarkets.map((v) => v.symbol).join(", ")}`
    );
  }

  const slippageBps = Math.floor((params.slippage ?? 0.5) * 100);

  if (params.fromAmount) {
    const amount = numberToSafeBN(params.fromAmount, fromToken.precision);
    const jupiterClient = new JupiterClient({
      connection: client.connection,
    });

    const quoteResponse = await (
      await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${fromToken.mint}&outputMint=${toToken.mint}&amount=${amount.toNumber()}&slippageBps=${slippageBps}&swapMode=ExactIn`
      )
    ).json();

    const txSig = await client.swap({
      amount,
      inMarketIndex: fromToken.marketIndex,
      outMarketIndex: toToken.marketIndex,
      jupiterClient,
      v6: { quote: quoteResponse },
      slippageBps,
      swapMode: "ExactIn",
    });

    logger.info("Jupiter swap executed", {
      from: `${params.fromAmount} ${params.fromSymbol}`,
      to: params.toSymbol,
      txSig,
    });

    return typeof txSig === "string" ? txSig : "";
  }

  if (params.toAmount) {
    const amount = numberToSafeBN(params.toAmount, toToken.precision);
    const jupiterClient = new JupiterClient({
      connection: client.connection,
    });

    const quoteResponse = await (
      await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${fromToken.mint}&outputMint=${toToken.mint}&amount=${amount.toNumber()}&slippageBps=${slippageBps}&swapMode=ExactOut`
      )
    ).json();

    const txSig = await client.swap({
      amount,
      inMarketIndex: toToken.marketIndex,
      outMarketIndex: fromToken.marketIndex,
      jupiterClient,
      v6: { quote: quoteResponse },
      slippageBps,
      swapMode: "ExactOut",
    });

    logger.info("Jupiter swap executed (ExactOut)", {
      from: params.fromSymbol,
      to: `${params.toAmount} ${params.toSymbol}`,
      txSig,
    });

    return typeof txSig === "string" ? txSig : "";
  }

  throw new Error("Either fromAmount or toAmount must be provided");
}
