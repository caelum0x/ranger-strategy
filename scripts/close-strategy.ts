/**
 * Close a strategy on a Ranger Earn vault.
 *
 * All funds must be withdrawn from the strategy before closing.
 * Only the manager can close strategies.
 *
 * Usage:
 *   npx ts-node scripts/close-strategy.ts --strategy <STRATEGY_PUBKEY>
 *   npx ts-node scripts/close-strategy.ts --strategy <PUBKEY> --vault <VAULT_PUBKEY>
 *
 * Required env:
 *   VAULT_PUBKEY or VOLTR_VAULT_ADDRESS
 *   MANAGER_KEYPAIR_PATH or ANCHOR_WALLET
 */
import { VoltrClient } from "@voltr/vault-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const STRATEGY_PUBKEY = getArg("strategy");
const VAULT_PUBKEY = getArg("vault", process.env.VAULT_PUBKEY || process.env.VOLTR_VAULT_ADDRESS);

async function main() {
  if (!STRATEGY_PUBKEY) {
    console.error("Usage: npx ts-node scripts/close-strategy.ts --strategy <STRATEGY_PUBKEY>");
    process.exit(1);
  }

  if (!VAULT_PUBKEY) {
    console.error("ERROR: No vault address. Pass --vault <PUBKEY> or set VAULT_PUBKEY in .env");
    process.exit(1);
  }

  const strategy = new PublicKey(STRATEGY_PUBKEY);
  const vault = new PublicKey(VAULT_PUBKEY);

  // Load manager keypair (manager closes strategies)
  const managerPath = process.env.MANAGER_KEYPAIR_PATH ||
    process.env.ANCHOR_WALLET;

  if (!managerPath || !fs.existsSync(managerPath)) {
    console.error("ERROR: No manager keypair found. Set MANAGER_KEYPAIR_PATH or ANCHOR_WALLET");
    process.exit(1);
  }

  const managerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(managerPath, "utf-8")))
  );

  const rpcUrl = process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const client = new VoltrClient(connection);

  console.log("═══ Close Strategy ═══");
  console.log(`  Vault:    ${vault.toBase58()}`);
  console.log(`  Strategy: ${strategy.toBase58()}`);
  console.log(`  Manager:  ${managerKp.publicKey.toBase58()}`);
  console.log("");

  const closeIx = await client.createCloseStrategyIx({
    payer: managerKp.publicKey,
    manager: managerKp.publicKey,
    vault,
    strategy,
  });

  console.log("Sending transaction...");
  const tx = new Transaction().add(closeIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [managerKp],
    { commitment: "confirmed" }
  );

  console.log(`\nStrategy closed: ${txSig}`);
}

main().catch((err) => {
  console.error("Close strategy failed:", err);
  process.exit(1);
});
