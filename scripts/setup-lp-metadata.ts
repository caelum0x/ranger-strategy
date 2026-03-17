/**
 * Set up LP token metadata for an existing vault.
 *
 * When users deposit into your vault, they receive LP tokens. Without metadata,
 * wallets display them as "Unknown Token." This script attaches name, symbol,
 * and a metadata URI so Phantom/Solflare/Jupiter show proper token info.
 *
 * Prerequisites:
 *   - Vault must already exist (run deploy-vault or init-vault first)
 *   - Host metadata JSON + logo at a public URL (GitHub, Arweave, or your domain)
 *   - Only the vault admin can create/update LP metadata
 *
 * Usage:
 *   npx ts-node scripts/setup-lp-metadata.ts
 *   npx ts-node scripts/setup-lp-metadata.ts --vault <VAULT_PUBKEY>
 *   npx ts-node scripts/setup-lp-metadata.ts --name "My LP" --symbol "mLP" --uri "https://..."
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

// ── Parse CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

// Default metadata URI — update with your actual hosted metadata.json
const DEFAULT_METADATA_URI =
  "https://raw.githubusercontent.com/cmertmarangoz/ranger-strategy/main/assets/metadata.json";

const LP_NAME = getArg("name", "AI DN Vault LP")!;
const LP_SYMBOL = getArg("symbol", "aiDN")!;
const LP_URI = getArg("uri", process.env.LP_METADATA_URI || DEFAULT_METADATA_URI)!;
const VAULT_PUBKEY = getArg("vault", process.env.VAULT_PUBKEY || process.env.VOLTR_VAULT_ADDRESS);

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!VAULT_PUBKEY) {
    console.error("ERROR: No vault address. Pass --vault <PUBKEY> or set VAULT_PUBKEY in .env");
    process.exit(1);
  }

  const vault = new PublicKey(VAULT_PUBKEY);

  // Load admin keypair (only admin can set metadata)
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

  console.log("═══ LP Token Metadata Setup ═══");
  console.log(`  Vault:  ${vault.toBase58()}`);
  console.log(`  Admin:  ${adminKp.publicKey.toBase58()}`);
  console.log(`  Name:   ${LP_NAME}`);
  console.log(`  Symbol: ${LP_SYMBOL}`);
  console.log(`  URI:    ${LP_URI}`);
  console.log("");

  // Create metadata instruction
  const metadataIx = await client.createCreateLpMetadataIx(
    {
      name: LP_NAME,
      symbol: LP_SYMBOL,
      uri: LP_URI,
    },
    {
      vault,
      admin: adminKp.publicKey,
      payer: adminKp.publicKey,
    }
  );

  // Send transaction
  console.log("Sending transaction...");
  const tx = new Transaction().add(metadataIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [adminKp],
    { commitment: "confirmed" }
  );

  console.log(`\nLP metadata created: ${txSig}`);
  console.log("");
  console.log("Wallets will now display your LP token with:");
  console.log(`  Name:   ${LP_NAME}`);
  console.log(`  Symbol: ${LP_SYMBOL}`);
  console.log(`  Logo:   (from metadata JSON at URI)`);
}

main().catch((err) => {
  console.error("LP metadata setup failed:", err);
  process.exit(1);
});
