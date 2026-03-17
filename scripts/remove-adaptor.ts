/**
 * Remove an adaptor program from a Ranger Earn vault.
 *
 * Only the admin can remove adaptors. All strategies using this adaptor
 * must be closed first.
 *
 * Usage:
 *   npx ts-node scripts/remove-adaptor.ts --adaptor drift
 *   npx ts-node scripts/remove-adaptor.ts --adaptor lending
 *   npx ts-node scripts/remove-adaptor.ts --adaptor <PROGRAM_ID>
 *
 * Required env:
 *   VAULT_PUBKEY or VOLTR_VAULT_ADDRESS
 *   ADMIN_KEYPAIR_PATH or ANCHOR_WALLET
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

const KNOWN_ADAPTORS: Record<string, PublicKey> = {
  lending:  LENDING_ADAPTOR_PROGRAM_ID,
  drift:    DRIFT_ADAPTOR_PROGRAM_ID,
  kamino:   new PublicKey("to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR"),
  raydium:  new PublicKey("A5a3Xo2JaKbXNShSHHP4Fe1LxcxNuCZs97gy3FJMSzkM"),
  jupiter:  new PublicKey("EW35URAx3LiM13fFK3QxAXfGemHso9HWPixrv7YDY4AM"),
  trustful: new PublicKey("3pnpK9nrs1R65eMV1wqCXkDkhSgN18xb1G5pgYPwoZjJ"),
};

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const ADAPTOR_ARG = getArg("adaptor");
const VAULT_PUBKEY = getArg("vault", process.env.VAULT_PUBKEY || process.env.VOLTR_VAULT_ADDRESS);

async function main() {
  if (!ADAPTOR_ARG) {
    console.error("Usage: npx ts-node scripts/remove-adaptor.ts --adaptor <NAME_OR_PROGRAM_ID>");
    console.error("Available names:", Object.keys(KNOWN_ADAPTORS).join(", "));
    process.exit(1);
  }

  if (!VAULT_PUBKEY) {
    console.error("ERROR: No vault address. Pass --vault <PUBKEY> or set VAULT_PUBKEY in .env");
    process.exit(1);
  }

  const adaptorProgramId = KNOWN_ADAPTORS[ADAPTOR_ARG.toLowerCase()]
    ?? new PublicKey(ADAPTOR_ARG);

  const adaptorName = Object.entries(KNOWN_ADAPTORS).find(
    ([, id]) => id.toBase58() === adaptorProgramId.toBase58()
  )?.[0] ?? "custom";

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

  console.log("═══ Remove Adaptor from Vault ═══");
  console.log(`  Vault:   ${vault.toBase58()}`);
  console.log(`  Admin:   ${adminKp.publicKey.toBase58()}`);
  console.log(`  Adaptor: ${adaptorName} (${adaptorProgramId.toBase58()})`);
  console.log("");

  const removeAdaptorIx = await client.createRemoveAdaptorIx({
    vault,
    admin: adminKp.publicKey,
    adaptorProgram: adaptorProgramId,
  });

  console.log("Sending transaction...");
  const tx = new Transaction().add(removeAdaptorIx);
  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [adminKp],
    { commitment: "confirmed" }
  );

  console.log(`\nAdaptor removed: ${txSig}`);
}

main().catch((err) => {
  console.error("Remove adaptor failed:", err);
  process.exit(1);
});
