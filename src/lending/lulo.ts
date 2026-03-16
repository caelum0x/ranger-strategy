/**
 * Lulo/Flexlend lending aggregator — optimized lending yield.
 *
 * Ported from lulo-plugin/tools/lulo_lend.ts + lulo_withdraw.ts.
 * Lulo aggregates across lending protocols (Solend, Marginfi, Kamino, etc.)
 * to find the best rate for your idle capital.
 *
 * Used by: strategy engine for idle USDC yield (between rebalance cycles).
 */
import { VersionedTransaction, Connection } from "@solana/web3.js";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface LuloLendResult {
  txSignature: string;
  protocol: string;
  apy: number;
}

// ── Constants ───────────────────────────────────────────────────

const FLEXLEND_API = "https://api.flexlend.fi";
const FLEXLEND_API_KEY = process.env.FLEXLEND_API_KEY || "";

// ── Lulo Functions ──────────────────────────────────────────────

/**
 * Lend tokens for optimized yield via Lulo/Flexlend.
 * From: lulo-plugin/tools/lulo_lend.ts → luloLend()
 *
 * Flexlend API returns a pre-built transaction that routes to
 * the highest-yielding lending protocol automatically.
 */
export async function luloLend(
  connection: Connection,
  walletPubkey: string,
  mintAddress: string,
  amount: number,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
): Promise<string> {
  if (!FLEXLEND_API_KEY) {
    throw new Error("FLEXLEND_API_KEY not configured");
  }

  const response = await fetch(
    `${FLEXLEND_API}/generate/account/deposit?priorityFee=50000`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-pubkey": walletPubkey,
        "x-api-key": FLEXLEND_API_KEY,
      },
      body: JSON.stringify({
        owner: walletPubkey,
        mintAddress,
        depositAmount: amount.toString(),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Lulo lend failed: ${response.status}`);
  }

  const {
    data: { transactionMeta },
  } = await response.json();

  const tx = VersionedTransaction.deserialize(
    Buffer.from(transactionMeta[0].transaction, "base64")
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.message.recentBlockhash = blockhash;

  const signed = await signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());

  logger.info("Lulo: lent tokens", { mintAddress, amount, signature });
  return signature;
}

/**
 * Withdraw lent tokens from Lulo/Flexlend.
 * From: lulo-plugin/tools/lulo_withdraw.ts → luloWithdraw()
 */
export async function luloWithdraw(
  connection: Connection,
  walletPubkey: string,
  mintAddress: string,
  amount: number,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
): Promise<string> {
  if (!FLEXLEND_API_KEY) {
    throw new Error("FLEXLEND_API_KEY not configured");
  }

  const response = await fetch(
    `${FLEXLEND_API}/generate/account/withdraw?priorityFee=50000`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-pubkey": walletPubkey,
        "x-api-key": FLEXLEND_API_KEY,
      },
      body: JSON.stringify({
        owner: walletPubkey,
        mintAddress,
        withdrawAmount: amount.toString(),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Lulo withdraw failed: ${response.status}`);
  }

  const {
    data: { transactionMeta },
  } = await response.json();

  const tx = VersionedTransaction.deserialize(
    Buffer.from(transactionMeta[0].transaction, "base64")
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.message.recentBlockhash = blockhash;

  const signed = await signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());

  logger.info("Lulo: withdrew tokens", { mintAddress, amount, signature });
  return signature;
}
