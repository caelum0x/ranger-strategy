/**
 * Sanctum LST integration — liquid staking token swaps + APY data.
 *
 * Ported from sanctum-plugin/tools/sanctum_*.ts.
 * Sanctum is the LST aggregator on Solana — swap between JitoSOL, mSOL,
 * bSOL, etc. at optimal rates.
 *
 * Used by: LST yield stacking strategy (use JitoSOL/mSOL as collateral
 * instead of raw SOL → earn staking APY + funding rate).
 */
import {
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { logger } from "../utils/logger";

// ── API Constants ───────────────────────────────────────────────

const SANCTUM_TRADE_API = "https://trade-api.sanctum.so";
const SANCTUM_STAT_API = "https://extra-api.sanctum.so";
const SANCTUM_PRICE_API = "https://pricing.sanctum.so";

// ── Types ───────────────────────────────────────────────────────

export interface LSTInfo {
  mint: string;
  symbol: string;
  apy: number;
  price: number; // price in SOL
  tvl?: number;
}

// ── LST APY Data ────────────────────────────────────────────────

/**
 * Get APY for one or more LSTs from Sanctum.
 * From: sanctum-plugin/tools/sanctum_get_lst_apy.ts
 */
export async function getLSTAPY(
  mints: string[]
): Promise<Record<string, number>> {
  const params = mints.map((m) => `lst=${m}`).join("&");
  const response = await fetch(
    `${SANCTUM_STAT_API}/v1/apy/latest?${params}`
  );
  if (!response.ok) throw new Error(`Sanctum APY fetch failed: ${response.status}`);

  const data = (await response.json()) as any;
  return data.apys || {};
}

/**
 * Get current LST prices in SOL.
 * From: sanctum-plugin/tools/sanctum_get_lst_price.ts
 */
export async function getLSTPrice(
  mints: string[]
): Promise<Record<string, number>> {
  const params = mints.map((m) => `lst=${m}`).join("&");
  const response = await fetch(
    `${SANCTUM_PRICE_API}/v1/lst/sol?${params}`
  );
  if (!response.ok) throw new Error(`Sanctum price fetch failed: ${response.status}`);

  const data = (await response.json()) as any;
  return data.prices || {};
}

/**
 * Get TVL for LSTs.
 * From: sanctum-plugin/tools/sanctum_get_lst_tvl.ts
 */
export async function getLSTTVL(
  mints: string[]
): Promise<Record<string, number>> {
  const params = mints.map((m) => `lst=${m}`).join("&");
  const response = await fetch(
    `${SANCTUM_STAT_API}/v1/tvl/latest?${params}`
  );
  if (!response.ok) throw new Error(`Sanctum TVL fetch failed: ${response.status}`);

  const data = (await response.json()) as any;
  return data.tvls || {};
}

// ── LST Swapping ────────────────────────────────────────────────

/**
 * Swap between LSTs via Sanctum Trade API.
 * From: sanctum-plugin/tools/sanctum_swap_lst.ts → sanctumSwapLST()
 *
 * Returns a pre-built transaction. The caller signs and sends it.
 */
export async function swapLST(
  connection: Connection,
  signerPubkey: PublicKey,
  inputLstMint: string,
  outputLstMint: string,
  amount: string,
  quotedAmount: string,
  priorityFee: number = 50_000,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
): Promise<string> {
  const response = await fetch(`${SANCTUM_TRADE_API}/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount,
      dstLstAcc: null,
      input: inputLstMint,
      mode: "ExactIn",
      priorityFee: {
        Auto: {
          max_unit_price_micro_lamports: priorityFee,
          unit_limit: 300_000,
        },
      },
      outputLstMint,
      quotedAmount,
      signer: signerPubkey.toBase58(),
      srcLstAcc: null,
    }),
  });

  if (!response.ok) {
    throw new Error(`Sanctum swap failed: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const txBuffer = Buffer.from(data.tx, "base64");
  const { blockhash } = await connection.getLatestBlockhash();

  // Deserialize, rebuild with fresh blockhash, re-sign
  const tx = VersionedTransaction.deserialize(txBuffer);
  const messages = tx.message;

  const instructions = messages.compiledInstructions.map((ix) => {
    return new TransactionInstruction({
      programId: messages.staticAccountKeys[ix.programIdIndex],
      keys: ix.accountKeyIndexes.map((i) => ({
        pubkey: messages.staticAccountKeys[i],
        isSigner: messages.isAccountSigner(i),
        isWritable: messages.isAccountWritable(i),
      })),
      data: Buffer.from(ix.data as any),
    });
  });

  const newMessage = new TransactionMessage({
    payerKey: signerPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const newTx = new VersionedTransaction(newMessage);
  const signed = await signTransaction(newTx);
  const signature = await connection.sendRawTransaction(signed.serialize());

  logger.info("Sanctum: LST swap executed", {
    input: inputLstMint.slice(0, 8),
    output: outputLstMint.slice(0, 8),
    amount,
    signature,
  });

  return signature;
}

// ── Well-known LST mints ────────────────────────────────────────

export const LST_MINTS = {
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  bSOL: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  stSOL: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
  jitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  INF: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
} as const;

/**
 * Get the best LST for yield stacking based on current APY.
 * Returns the LST with highest APY from Sanctum data.
 */
export async function getBestLSTForYield(): Promise<{
  symbol: string;
  mint: string;
  apy: number;
} | null> {
  try {
    const mints = [LST_MINTS.JitoSOL, LST_MINTS.mSOL, LST_MINTS.bSOL];
    const apys = await getLSTAPY(mints);

    let best: { symbol: string; mint: string; apy: number } | null = null;
    const entries: [string, string][] = [
      ["JitoSOL", LST_MINTS.JitoSOL],
      ["mSOL", LST_MINTS.mSOL],
      ["bSOL", LST_MINTS.bSOL],
    ];

    for (const [symbol, mint] of entries) {
      const apy = apys[mint] || 0;
      if (!best || apy > best.apy) {
        best = { symbol, mint, apy };
      }
    }

    if (best) {
      logger.info("Best LST for yield stacking", {
        symbol: best.symbol,
        apy: `${(best.apy * 100).toFixed(2)}%`,
      });
    }

    return best;
  } catch (err) {
    logger.warn("Failed to get LST APYs from Sanctum", { error: String(err) });
    return null;
  }
}
