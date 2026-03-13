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
 * Cobo MPC wallet stub.
 *
 * In production deployments, keys are managed by Cobo's MPC infrastructure
 * rather than stored locally. This removes the single-point-of-compromise risk
 * that comes with raw keypair files or environment variables.
 *
 * Cobo was a hackathon sponsor and offers free testing accounts for teams
 * building on their MPC platform — see https://www.cobo.com/web3 for details.
 *
 * Full integration requires the `@aspect-build/cobo-sdk` package which
 * provides the MPC signing client. The Wallet adapter wraps the Cobo signer
 * so it satisfies the Drift SDK's Wallet interface.
 */
function fromCobo(_config: WalletProviderConfig): WalletProviderResult {
  let coboSdkAvailable = false;
  try {
    require.resolve("@aspect-build/cobo-sdk");
    coboSdkAvailable = true;
  } catch {
    // SDK not installed
  }

  if (!coboSdkAvailable) {
    console.error(
      "[wallet/provider] Cobo MPC integration requires @aspect-build/cobo-sdk — " +
        "see https://www.cobo.com/web3"
    );
    throw new Error(
      "Cobo MPC wallet requires @aspect-build/cobo-sdk to be installed. " +
        "Install it with: npm install @aspect-build/cobo-sdk"
    );
  }

  // If the SDK is installed, a real implementation would initialise the Cobo
  // MPC client here and wrap it in a Drift-compatible Wallet adapter.
  // This is left as a stub until the full integration is built out.
  throw new Error(
    "Cobo MPC wallet: SDK detected but full integration is not yet implemented. " +
      "Contributions welcome — see https://www.cobo.com/web3 for the API reference."
  );
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
