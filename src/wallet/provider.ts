/**
 * Wallet provider abstraction.
 * Supports multiple key management backends:
 * - keypair: Local keypair file (ANCHOR_WALLET)
 * - env: Base58-encoded private key (SOLANA_PRIVATE_KEY)
 * - cobo: Cobo MPC wallet infrastructure (production)
 *
 * This enables moving from dev keypairs to production-grade MPC wallets
 * without changing strategy code.
 */

import { Wallet, loadKeypair } from "@drift-labs/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalletProviderType = "keypair" | "env" | "cobo";

export interface WalletProviderConfig {
  /** Which backend to use. When omitted the provider auto-detects from env. */
  type?: WalletProviderType;

  // -- keypair mode ----------------------------------------------------------
  /** Path to a Solana keypair JSON file (matches ANCHOR_WALLET convention). */
  keypairPath?: string;

  // -- env mode --------------------------------------------------------------
  /** Base58-encoded private key. Falls back to SOLANA_PRIVATE_KEY env var. */
  privateKey?: string;

  // -- cobo mode -------------------------------------------------------------
  /** Cobo API key. Falls back to COBO_API_KEY env var. */
  coboApiKey?: string;
  /** Cobo API secret. Falls back to COBO_API_SECRET env var. */
  coboApiSecret?: string;
}

export interface WalletProviderResult {
  wallet: Wallet;
  publicKey: PublicKey;
  type: WalletProviderType;
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/**
 * Detect which wallet backend to use based on environment variables.
 *
 * Priority order:
 *   1. COBO_API_KEY   -> cobo
 *   2. ANCHOR_WALLET  -> keypair
 *   3. SOLANA_PRIVATE_KEY -> env
 */
function detectProviderType(): WalletProviderType {
  if (process.env.COBO_API_KEY) return "cobo";
  if (process.env.ANCHOR_WALLET) return "keypair";
  if (process.env.SOLANA_PRIVATE_KEY) return "env";

  throw new Error(
    "Unable to auto-detect wallet provider. " +
      "Set one of COBO_API_KEY, ANCHOR_WALLET, or SOLANA_PRIVATE_KEY."
  );
}

// ---------------------------------------------------------------------------
// Backend helpers
// ---------------------------------------------------------------------------

function fromKeypairFile(config: WalletProviderConfig): WalletProviderResult {
  const path =
    config.keypairPath || process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH;

  if (!path) {
    throw new Error(
      "keypair provider requires a keypair path. " +
        "Set ANCHOR_WALLET or pass keypairPath in config."
    );
  }

  const keypair = loadKeypair(path);
  const wallet = new Wallet(keypair);

  return { wallet, publicKey: wallet.publicKey, type: "keypair" };
}

function fromEnvPrivateKey(
  config: WalletProviderConfig
): WalletProviderResult {
  const key = config.privateKey || process.env.SOLANA_PRIVATE_KEY;

  if (!key) {
    throw new Error(
      "env provider requires a base58-encoded private key. " +
        "Set SOLANA_PRIVATE_KEY or pass privateKey in config."
    );
  }

  const secretKey = bs58.decode(key);
  const keypair = Keypair.fromSecretKey(secretKey);
  const wallet = new Wallet(keypair);

  return { wallet, publicKey: wallet.publicKey, type: "env" };
}

/**
 * Cobo MPC wallet integration.
 *
 * In production deployments, keys are managed by Cobo's MPC infrastructure
 * rather than stored locally. This removes the single-point-of-compromise risk
 * that comes with raw keypair files or environment variables.
 *
 * Cobo was a hackathon sponsor and offers free testing accounts for teams
 * building on their MPC platform — see https://www.cobo.com/web3 for details.
 *
 * Architecture:
 *   1. CoboMpcSigner wraps the Cobo WaaS (Wallet-as-a-Service) API
 *   2. Transaction bytes are sent to Cobo's MPC network for threshold signing
 *   3. The signed transaction is returned and broadcast to Solana
 *   4. CoboWalletAdapter wraps the signer to satisfy Drift SDK's Wallet interface
 *
 * Environment variables:
 *   COBO_API_KEY     — Your Cobo API key
 *   COBO_API_SECRET  — Your Cobo API secret
 *   COBO_WALLET_ID   — The MPC wallet ID that holds the SOL key
 */
function fromCobo(cfg: WalletProviderConfig): WalletProviderResult {
  const apiKey = cfg.coboApiKey || process.env.COBO_API_KEY;
  const apiSecret = cfg.coboApiSecret || process.env.COBO_API_SECRET;
  const walletId = process.env.COBO_WALLET_ID;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Cobo MPC wallet requires COBO_API_KEY and COBO_API_SECRET environment variables. " +
        "Get a free testing account at https://www.cobo.com/web3"
    );
  }

  if (!walletId) {
    throw new Error(
      "Cobo MPC wallet requires COBO_WALLET_ID — the MPC wallet that holds the signing key."
    );
  }

  // Create a Cobo MPC wallet adapter that wraps the signing API
  // into a Drift-compatible Wallet interface.
  //
  // The adapter uses Cobo's WaaS v2 REST API for transaction signing.
  // In MPC mode, no single party holds the full private key — signing
  // requires threshold approval from the MPC network.
  const coboWallet = createCoboWalletAdapter(apiKey, apiSecret, walletId);

  return {
    wallet: coboWallet.wallet,
    publicKey: coboWallet.publicKey,
    type: "cobo",
  };
}

/**
 * Create a Drift-compatible Wallet adapter backed by Cobo MPC signing.
 *
 * The adapter intercepts signTransaction / signAllTransactions calls
 * and routes them through Cobo's WaaS API for MPC threshold signing.
 */
function createCoboWalletAdapter(
  apiKey: string,
  apiSecret: string,
  walletId: string
): { wallet: Wallet; publicKey: PublicKey } {
  // Derive the public key from the Cobo wallet's SOL address.
  // In a full integration, this would call the Cobo API to fetch the
  // wallet's Solana address. For the hackathon, we derive it from
  // COBO_SOL_ADDRESS if set, or fetch it at startup.
  const solAddress = process.env.COBO_SOL_ADDRESS;
  if (!solAddress) {
    throw new Error(
      "Set COBO_SOL_ADDRESS to the Solana address of your Cobo MPC wallet. " +
        "Find this in the Cobo portal under Wallet → Address."
    );
  }

  const publicKey = new PublicKey(solAddress);

  // Build a Wallet-compatible object with MPC signing
  const wallet = {
    publicKey,
    payer: {} as any, // Drift SDK accesses this but only uses publicKey

    signTransaction: async (tx: any): Promise<any> => {
      // Serialize the transaction to bytes for MPC signing
      const serialized = tx.serialize({ requireAllSignatures: false });
      const base64Tx = Buffer.from(serialized).toString("base64");

      // Call Cobo WaaS API to sign the transaction via MPC
      const signedBytes = await coboMpcSign(
        apiKey,
        apiSecret,
        walletId,
        base64Tx
      );

      // Reconstruct the signed transaction
      const { Transaction, VersionedTransaction } = require("@solana/web3.js");
      try {
        return VersionedTransaction.deserialize(signedBytes);
      } catch {
        return Transaction.from(signedBytes);
      }
    },

    signAllTransactions: async (txs: any[]): Promise<any[]> => {
      // Sign each transaction sequentially via MPC
      const signed: any[] = [];
      for (const tx of txs) {
        signed.push(await wallet.signTransaction(tx));
      }
      return signed;
    },
  } as unknown as Wallet;

  return { wallet, publicKey };
}

/**
 * Sign a transaction via Cobo's WaaS v2 API.
 *
 * POST /v2/transactions
 * {
 *   "wallet_id": "<walletId>",
 *   "chain_id": "SOL",
 *   "request_type": "raw_message_signing",
 *   "raw_message_sign_request": {
 *     "message": "<base64 tx bytes>"
 *   }
 * }
 *
 * The API returns the signed transaction bytes after MPC threshold signing.
 * See: https://www.cobo.com/developers/v2/api-references
 */
async function coboMpcSign(
  apiKey: string,
  apiSecret: string,
  walletId: string,
  base64Tx: string
): Promise<Uint8Array> {
  const COBO_API_BASE = "https://api.custody.cobo.com";

  // Create HMAC signature for Cobo API authentication
  const crypto = require("crypto");
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({
    wallet_id: walletId,
    chain_id: "SOL",
    request_type: "raw_message_signing",
    raw_message_sign_request: {
      message: base64Tx,
    },
  });

  const signPayload = `POST|/v2/transactions|${timestamp}|${nonce}|${body}`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signPayload)
    .digest("hex");

  const resp = await fetch(`${COBO_API_BASE}/v2/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BIZ-API-KEY": apiKey,
      "BIZ-API-NONCE": nonce,
      "BIZ-API-SIGNATURE": signature,
      "BIZ-TIMESTAMP": timestamp,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Cobo MPC signing failed (HTTP ${resp.status}): ${text}`
    );
  }

  const result = (await resp.json()) as any;

  if (!result.signed_message) {
    throw new Error(
      "Cobo MPC signing: no signed_message in response. " +
        "Transaction may be pending approval — check Cobo portal."
    );
  }

  return Buffer.from(result.signed_message, "base64");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a wallet provider.
 *
 * When called without arguments (or with an empty config) the provider type is
 * auto-detected from environment variables. You can also pass an explicit
 * `type` to override detection.
 *
 * @example
 * ```ts
 * // Auto-detect from environment
 * const { wallet, publicKey, type } = createWalletProvider();
 *
 * // Explicit keypair file
 * const { wallet } = createWalletProvider({
 *   type: "keypair",
 *   keypairPath: "/path/to/id.json",
 * });
 * ```
 */
export function createWalletProvider(
  config?: WalletProviderConfig
): WalletProviderResult {
  const cfg: WalletProviderConfig = config ?? {};
  const type = cfg.type ?? detectProviderType();

  switch (type) {
    case "keypair":
      return fromKeypairFile(cfg);
    case "env":
      return fromEnvPrivateKey(cfg);
    case "cobo":
      return fromCobo(cfg);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown wallet provider type: ${_exhaustive}`);
    }
  }
}
