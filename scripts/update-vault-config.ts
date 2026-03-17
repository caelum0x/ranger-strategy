/**
 * Update vault configuration parameters after creation.
 *
 * Only the admin wallet can update vault config. Each invocation updates
 * one field at a time using createUpdateVaultConfigIx.
 *
 * Updatable fields:
 *   max-cap, start-at, locked-profit-duration, withdrawal-wait,
 *   manager-perf-fee, admin-perf-fee, manager-mgmt-fee, admin-mgmt-fee,
 *   redemption-fee, issuance-fee, manager, pending-admin
 *
 * NOT updatable: name, description, asset mint (set at creation)
 *
 * Usage:
 *   npx ts-node scripts/update-vault-config.ts --field max-cap --value 1000000000000
 *   npx ts-node scripts/update-vault-config.ts --field manager-perf-fee --value 1500
 *   npx ts-node scripts/update-vault-config.ts --field manager --value <NEW_MANAGER_PUBKEY>
 *   npx ts-node scripts/update-vault-config.ts --field withdrawal-wait --value 604800
 *
 * Fee values are in basis points (e.g., 1500 = 15%, 100 = 1%, 10 = 0.1%)
 * Duration values are in seconds (e.g., 604800 = 7 days, 86400 = 24 hours)
 */
import { BN } from "@coral-xyz/anchor";
import { VoltrClient, VaultConfigField } from "@voltr/vault-sdk";
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

// ── CLI-friendly field names → VaultConfigField enum ────────────

const FIELD_MAP: Record<string, VaultConfigField> = {
  "max-cap":                VaultConfigField.MaxCap,
  "start-at":               VaultConfigField.StartAtTs,
  "locked-profit-duration": VaultConfigField.LockedProfitDegradationDuration,
  "withdrawal-wait":        VaultConfigField.WithdrawalWaitingPeriod,
  "manager-perf-fee":       VaultConfigField.ManagerPerformanceFee,
  "admin-perf-fee":         VaultConfigField.AdminPerformanceFee,
  "manager-mgmt-fee":       VaultConfigField.ManagerManagementFee,
  "admin-mgmt-fee":         VaultConfigField.AdminManagementFee,
  "redemption-fee":         VaultConfigField.RedemptionFee,
  "issuance-fee":           VaultConfigField.IssuanceFee,
  "manager":                VaultConfigField.Manager,
  "pending-admin":          VaultConfigField.PendingAdmin,
};

// Fields that are u64 (8-byte LE)
const U64_FIELDS = new Set([
  VaultConfigField.MaxCap,
  VaultConfigField.StartAtTs,
  VaultConfigField.LockedProfitDegradationDuration,
  VaultConfigField.WithdrawalWaitingPeriod,
]);

// Fields that are u16 (2-byte LE, basis points)
const U16_FIELDS = new Set([
  VaultConfigField.ManagerPerformanceFee,
  VaultConfigField.AdminPerformanceFee,
  VaultConfigField.ManagerManagementFee,
  VaultConfigField.AdminManagementFee,
  VaultConfigField.RedemptionFee,
  VaultConfigField.IssuanceFee,
]);

// Fields that are PublicKey (32 bytes)
const PUBKEY_FIELDS = new Set([
  VaultConfigField.Manager,
  VaultConfigField.PendingAdmin,
]);

// Management fee fields require vaultLpMint in accounts
const MGMT_FEE_FIELDS = new Set([
  VaultConfigField.ManagerManagementFee,
  VaultConfigField.AdminManagementFee,
]);

// ── Parse CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const FIELD_NAME = getArg("field");
const RAW_VALUE = getArg("value");
const VAULT_PUBKEY = getArg("vault", process.env.VAULT_PUBKEY || process.env.VOLTR_VAULT_ADDRESS);

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!FIELD_NAME || !RAW_VALUE) {
    console.error("Usage: npx ts-node scripts/update-vault-config.ts --field <FIELD> --value <VALUE>");
    console.error("");
    console.error("Available fields:");
    for (const [name, field] of Object.entries(FIELD_MAP)) {
      const type = U64_FIELDS.has(field) ? "u64" : U16_FIELDS.has(field) ? "u16 (bps)" : "PublicKey";
      console.error(`  ${name.padEnd(25)} ${type}`);
    }
    process.exit(1);
  }

  if (!VAULT_PUBKEY) {
    console.error("ERROR: No vault address. Pass --vault <PUBKEY> or set VAULT_PUBKEY in .env");
    process.exit(1);
  }

  const configField = FIELD_MAP[FIELD_NAME];
  if (!configField) {
    console.error(`ERROR: Unknown field "${FIELD_NAME}"`);
    console.error("Available fields:", Object.keys(FIELD_MAP).join(", "));
    process.exit(1);
  }

  const vault = new PublicKey(VAULT_PUBKEY);

  // Load admin keypair
  const adminPath = process.env.ADMIN_KEYPAIR_PATH ||
    process.env.ANCHOR_WALLET;

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

  // ── Serialize value based on field type ──
  let data: Buffer;
  let displayValue: string;

  if (U64_FIELDS.has(configField)) {
    const bn = new BN(RAW_VALUE);
    data = bn.toArrayLike(Buffer, "le", 8);
    displayValue = bn.toString();
  } else if (U16_FIELDS.has(configField)) {
    const num = parseInt(RAW_VALUE, 10);
    if (isNaN(num) || num < 0 || num > 10000) {
      console.error("ERROR: Fee value must be 0-10000 basis points");
      process.exit(1);
    }
    data = Buffer.alloc(2);
    data.writeUInt16LE(num, 0);
    displayValue = `${num} bps (${(num / 100).toFixed(2)}%)`;
  } else if (PUBKEY_FIELDS.has(configField)) {
    const pubkey = new PublicKey(RAW_VALUE);
    data = pubkey.toBuffer();
    displayValue = pubkey.toBase58();
  } else {
    console.error("ERROR: Unsupported field type");
    process.exit(1);
  }

  console.log("═══ Update Vault Config ═══");
  console.log(`  Vault: ${vault.toBase58()}`);
  console.log(`  Admin: ${adminKp.publicKey.toBase58()}`);
  console.log(`  Field: ${FIELD_NAME} (${configField})`);
  console.log(`  Value: ${displayValue}`);
  console.log("");

  // ── Build accounts (management fees need vaultLpMint) ──
  const accounts: { vault: PublicKey; admin: PublicKey; vaultLpMint?: PublicKey } = {
    vault,
    admin: adminKp.publicKey,
  };

  if (MGMT_FEE_FIELDS.has(configField)) {
    accounts.vaultLpMint = client.findVaultLpMint(vault);
    console.log(`  LP Mint: ${accounts.vaultLpMint.toBase58()} (required for mgmt fee updates)`);
  }

  // ── Create and send instruction ──
  const updateIx = await client.createUpdateVaultConfigIx(
    configField,
    data,
    accounts
  );

  console.log("Sending transaction...");
  const tx = new Transaction().add(updateIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [adminKp],
    { commitment: "confirmed" }
  );

  console.log(`\nConfig updated: ${txSig}`);
}

main().catch((err) => {
  console.error("Vault config update failed:", err);
  process.exit(1);
});
