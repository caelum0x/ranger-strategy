/**
 * Harvest accumulated fees from a Ranger Earn vault.
 *
 * Can be called by anyone — fees go to the designated admin/manager/protocol recipients.
 * Shows accumulated fees before harvesting.
 *
 * Usage:
 *   npx ts-node scripts/harvest-fees.ts
 *   npx ts-node scripts/harvest-fees.ts --vault <VAULT_PUBKEY>
 *
 * Required env:
 *   VAULT_PUBKEY          — vault to harvest from
 *   ANCHOR_WALLET or any keypair — harvester (pays gas, anyone can call)
 *   HELIUS_RPC_URL or SOLANA_RPC_URL
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

const VAULT_PUBKEY = getArg("vault", process.env.VAULT_PUBKEY || process.env.VOLTR_VAULT_ADDRESS);

async function main() {
  if (!VAULT_PUBKEY) {
    console.error("ERROR: No vault address. Pass --vault <PUBKEY> or set VAULT_PUBKEY in .env");
    process.exit(1);
  }

  const vault = new PublicKey(VAULT_PUBKEY);

  // Load harvester keypair (anyone can harvest, fees go to designated recipients)
  const keypairPath = process.env.ADMIN_KEYPAIR_PATH ||
    process.env.MANAGER_KEYPAIR_PATH ||
    process.env.ANCHOR_WALLET;

  if (!keypairPath || !fs.existsSync(keypairPath)) {
    console.error("ERROR: No keypair found. Set ADMIN_KEYPAIR_PATH, MANAGER_KEYPAIR_PATH, or ANCHOR_WALLET");
    process.exit(1);
  }

  const harvesterKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
  );

  const rpcUrl = process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const client = new VoltrClient(connection);

  // Fetch vault to get admin/manager addresses
  const vaultAccount = await client.fetchVaultAccount(vault);

  // Show current fee accumulation
  const managerFees = await client.getAccumulatedManagerFeesForVault(vault);
  const adminFees = await client.getAccumulatedAdminFeesForVault(vault);
  const hwm = await client.getHighWaterMarkForVault(vault);
  const sharePrice = await client.getCurrentAssetPerLpForVault(vault);

  console.log("═══ Harvest Fees ═══");
  console.log(`  Vault:     ${vault.toBase58()}`);
  console.log(`  Harvester: ${harvesterKp.publicKey.toBase58()}`);
  console.log("");
  console.log("--- Accumulated Fees (LP tokens) ---");
  console.log(`  Manager fees: ${managerFees.toString()}`);
  console.log(`  Admin fees:   ${adminFees.toString()}`);
  console.log("");
  console.log("--- High Water Mark ---");
  console.log(`  HWM (asset/LP):     ${hwm.highestAssetPerLp}`);
  console.log(`  Current (asset/LP): ${sharePrice}`);
  console.log(`  Last updated:       ${new Date(hwm.lastUpdatedTs * 1000).toISOString()}`);
  console.log("");

  // Build harvest instruction
  // protocolAdmin: use the protocol PDA's admin (for permissionless harvest, use vault admin as fallback)
  const harvestIx = await client.createHarvestFeeIx({
    harvester: harvesterKp.publicKey,
    vaultManager: vaultAccount.manager,
    vaultAdmin: vaultAccount.admin,
    protocolAdmin: vaultAccount.admin,
    vault,
  });

  console.log("Sending transaction...");
  const tx = new Transaction().add(harvestIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [harvesterKp],
    { commitment: "confirmed" }
  );

  console.log(`\nFees harvested: ${txSig}`);
}

main().catch((err) => {
  console.error("Fee harvest failed:", err);
  process.exit(1);
});
