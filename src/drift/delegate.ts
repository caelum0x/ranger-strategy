/**
 * Drift delegated trading support.
 * Enables an AI agent to trade on behalf of a vault owner.
 *
 * Flow:
 * 1. Vault owner sets the agent's pubkey as delegate on their Drift user account
 * 2. Agent initializes DriftClient with the vault owner's authority
 * 3. Agent places orders using the vault's Drift sub-account
 *
 * See: protocol-v2/sdk/src/driftClient.ts → updateUserDelegate()
 */
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  BN,
  QUOTE_PRECISION,
} from "@drift-labs/sdk";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";

export interface DelegateConfig {
  /** The vault owner's Drift authority (their wallet pubkey) */
  vaultAuthority: PublicKey;
  /** Sub-account ID on the vault owner's Drift account */
  subAccountId: number;
  /** The delegate's (agent's) wallet */
  delegateWallet: Wallet;
}

/**
 * Create a DriftClient configured for delegated trading.
 *
 * IMPORTANT: When signing on behalf of a delegated account, you MUST
 * explicitly set subAccountIds, activeSubAccountId, and authority.
 * Omitting any of these will cause the client to subscribe to the wrong accounts.
 */
export async function createDelegatedDriftClient(
  cfg: DelegateConfig
): Promise<DriftClient> {
  const { Connection } = require("@solana/web3.js");
  const connection = new Connection(config.solanaRpcUrl, "confirmed");

  const accountLoader = new BulkAccountLoader(
    connection as any,
    "confirmed",
    1000
  );

  const client = new DriftClient({
    connection: connection as any,
    wallet: cfg.delegateWallet,
    env: config.driftEnv,
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
    // CRITICAL for delegated accounts:
    authority: cfg.vaultAuthority,
    activeSubAccountId: cfg.subAccountId,
    subAccountIds: [cfg.subAccountId],
  });

  await client.subscribe();

  logger.info("Delegated DriftClient created", {
    vaultAuthority: cfg.vaultAuthority.toBase58(),
    subAccountId: cfg.subAccountId,
    delegate: cfg.delegateWallet.publicKey.toBase58(),
  });

  return client;
}

/**
 * Set up a wallet as a delegate for a Drift user account.
 * This must be called by the vault owner (not the delegate).
 */
export async function setupDelegate(
  ownerClient: DriftClient,
  delegatePubkey: PublicKey,
  subAccountId: number = 0
): Promise<void> {
  logger.info("Setting up delegate", {
    delegate: delegatePubkey.toBase58(),
    subAccountId,
  });

  await ownerClient.updateUserDelegate(delegatePubkey, subAccountId);

  logger.info("Delegate set successfully");
}

/**
 * Enable margin trading on a Drift user account.
 * Required for the vault to place perp orders.
 */
export async function enableMarginTrading(
  client: DriftClient,
  subAccountId: number = 0
): Promise<void> {
  logger.info("Enabling margin trading", { subAccountId });

  await client.updateUserMarginTradingEnabled([
    { marginTradingEnabled: true, subAccountId },
  ]);

  logger.info("Margin trading enabled");
}
