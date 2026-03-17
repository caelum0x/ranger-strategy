/**
 * Add an adaptor program to an existing Ranger Earn vault.
 *
 * This is a one-time operation per adaptor type. You must add an adaptor
 * before you can initialize any strategy that uses it.
 *
 * Available adaptors:
 *   Lending Adaptor:  aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz
 *   Drift Adaptor:    EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP
 *   Kamino Adaptor:   to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR
 *
 * Usage:
 *   npx ts-node scripts/add-adaptor.ts --adaptor drift
 *   npx ts-node scripts/add-adaptor.ts --adaptor lending
 *   npx ts-node scripts/add-adaptor.ts --adaptor kamino
 *   npx ts-node scripts/add-adaptor.ts --adaptor <PROGRAM_ID>
 *
 * Required env:
 *   VAULT_PUBKEY or VOLTR_VAULT_ADDRESS — vault to add adaptor to
 *   ADMIN_KEYPAIR_PATH or ANCHOR_WALLET — admin keypair (only admin can add adaptors)
 *   HELIUS_RPC_URL or SOLANA_RPC_URL    — RPC endpoint
 */
import {
  VoltrClient,
  LENDING_ADAPTOR_PROGRAM_ID,
  DRIFT_ADAPTOR_PROGRAM_ID,
} from "@voltr/vault-sdk";
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

// ── Known adaptor program IDs (SDK exports + additional) ────────

const KNOWN_ADAPTORS: Record<string, PublicKey> = {
  lending: LENDING_ADAPTOR_PROGRAM_ID,
  drift:   DRIFT_ADAPTOR_PROGRAM_ID,
  kamino:  new PublicKey("to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR"),
  raydium: new PublicKey("A5a3Xo2JaKbXNShSHHP4Fe1LxcxNuCZs97gy3FJMSzkM"),
  jupiter: new PublicKey("EW35URAx3LiM13fFK3QxAXfGemHso9HWPixrv7YDY4AM"),
  trustful: new PublicKey("3pnpK9nrs1R65eMV1wqCXkDkhSgN18xb1G5pgYPwoZjJ"),
};

// ── Parse CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const ADAPTOR_ARG = getArg("adaptor", "drift")!;
const VAULT_PUBKEY = getArg("vault", process.env.VAULT_PUBKEY || process.env.VOLTR_VAULT_ADDRESS);

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!VAULT_PUBKEY) {
    console.error("ERROR: No vault address. Pass --vault <PUBKEY> or set VAULT_PUBKEY in .env");
    process.exit(1);
  }

  // Resolve adaptor program ID (name or raw pubkey)
  const adaptorProgramId = KNOWN_ADAPTORS[ADAPTOR_ARG.toLowerCase()]
    ?? new PublicKey(ADAPTOR_ARG);

  const adaptorName = Object.entries(KNOWN_ADAPTORS).find(
    ([, id]) => id.toBase58() === adaptorProgramId.toBase58()
  )?.[0] ?? "custom";

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

  console.log("═══ Add Adaptor to Vault ═══");
  console.log(`  Vault:   ${vault.toBase58()}`);
  console.log(`  Admin:   ${adminKp.publicKey.toBase58()}`);
  console.log(`  Adaptor: ${adaptorName} (${adaptorProgramId.toBase58()})`);
  console.log("");

  // Create add adaptor instruction
  const addAdaptorIx = await client.createAddAdaptorIx({
    vault,
    admin: adminKp.publicKey,
    payer: adminKp.publicKey,
    adaptorProgram: adaptorProgramId,
  });

  // Send transaction
  console.log("Sending transaction...");
  const tx = new Transaction().add(addAdaptorIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [adminKp],
    { commitment: "confirmed" }
  );

  console.log(`\nAdaptor added: ${txSig}`);
  console.log("");
  console.log("Next: Initialize a strategy using this adaptor:");
  console.log("  npx ts-node scripts/init-strategy.ts");
}

main().catch((err) => {
  console.error("Add adaptor failed:", err);
  process.exit(1);
});
