/**
 * Calibrate the high water mark for a Ranger Earn vault.
 *
 * Resets the performance fee baseline. Only the admin can calibrate.
 * After calibration, performance fees are only charged on profits
 * above the new HWM level.
 *
 * Usage:
 *   npx ts-node scripts/calibrate-hwm.ts
 *   npx ts-node scripts/calibrate-hwm.ts --vault <VAULT_PUBKEY>
 *
 * Required env:
 *   VAULT_PUBKEY or VOLTR_VAULT_ADDRESS
 *   ADMIN_KEYPAIR_PATH or ANCHOR_WALLET
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

  const adminPath = process.env.ADMIN_KEYPAIR_PATH || process.env.ANCHOR_WALLET;
  if (!adminPath || !fs.existsSync(adminPath)) {
    console.error("ERROR: No admin keypair found. Set ADMIN_KEYPAIR_PATH or ANCHOR_WALLET");
    process.exit(1);
  }

  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf-8")))
  );

  const rpcUrl = process.env.HELIUS_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const client = new VoltrClient(connection);

  // Show current HWM before calibration
  const hwm = await client.getHighWaterMarkForVault(vault);
  const sharePrice = await client.getCurrentAssetPerLpForVault(vault);

  console.log("═══ Calibrate High Water Mark ═══");
  console.log(`  Vault: ${vault.toBase58()}`);
  console.log(`  Admin: ${adminKp.publicKey.toBase58()}`);
  console.log("");
  console.log("--- Before Calibration ---");
  console.log(`  Current HWM (asset/LP):  ${hwm.highestAssetPerLp}`);
  console.log(`  Current share price:     ${sharePrice}`);
  console.log(`  HWM last updated:        ${new Date(hwm.lastUpdatedTs * 1000).toISOString()}`);
  console.log("");

  const calibrateIx = await client.createCalibrateHighWaterMarkIx({
    vault,
    admin: adminKp.publicKey,
  });

  console.log("Sending transaction...");
  const tx = new Transaction().add(calibrateIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [adminKp],
    { commitment: "confirmed" }
  );

  console.log(`\nHigh water mark calibrated: ${txSig}`);

  // Show updated HWM
  const newHwm = await client.getHighWaterMarkForVault(vault);
  console.log(`  New HWM (asset/LP): ${newHwm.highestAssetPerLp}`);
}

main().catch((err) => {
  console.error("HWM calibration failed:", err);
  process.exit(1);
});
