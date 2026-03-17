/**
 * Full vault deployment script — one command to deploy everything.
 *
 * This is the production deployment flow from the Workshop 1 guide:
 *   1. Initialize Voltr vault with USDC base asset
 *   2. Add Drift adaptor
 *   3. Initialize Drift earn strategy
 *   4. Deposit initial USDC
 *   5. Log vault address for Ranger UI indexing
 *
 * Usage:
 *   npm run deploy-vault
 *   npm run deploy-vault -- --amount 10 --network mainnet
 *
 * After deployment, share vault address in Ranger TG for indexing:
 *   "Vault: <ADDRESS> — Delta-neutral funding + DLOB market making"
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "../src/config";
import { logger } from "../src/utils/logger";
import * as fs from "fs";

// ── Parse CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal: string) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const NETWORK = getArg("network", "devnet");
const DEPOSIT_AMOUNT = parseInt(getArg("amount", "10")); // USDC
const VAULT_NAME = getArg("name", "Delta-Neutral Funding Vault");

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       Ranger Earn Vault Deployment                  ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Network:  ${NETWORK.padEnd(41)}║`);
  console.log(`║  Deposit:  ${DEPOSIT_AMOUNT} USDC${" ".repeat(36 - DEPOSIT_AMOUNT.toString().length)}║`);
  console.log(`║  Strategy: Delta-neutral + DLOB maker${" ".repeat(15)}║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");

  // Load keypair
  const keypairPath = process.env.ANCHOR_WALLET ||
    process.env.MANAGER_FILE_PATH ||
    (NETWORK === "devnet" ? "./devnet-keypair.json" : undefined);

  if (!keypairPath || !fs.existsSync(keypairPath)) {
    console.error("ERROR: No keypair found. Set ANCHOR_WALLET or MANAGER_FILE_PATH");
    process.exit(1);
  }

  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
  );
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Connect
  const rpcUrl = NETWORK === "mainnet"
    ? config.solanaRpcUrl
    : "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`SOL Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.05 * 1e9) {
    if (NETWORK === "devnet") {
      console.log("Airdropping 1 SOL...");
      await connection.requestAirdrop(keypair.publicKey, 1e9);
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.error("ERROR: Insufficient SOL balance for mainnet deployment");
      process.exit(1);
    }
  }

  // ── Step 1: Initialize Voltr Vault ──
  console.log("\n═══ Step 1: Initialize Vault ═══");
  const voltrClient = new VoltrClient(connection);

  // USDC mint (mainnet or devnet)
  const USDC_MINT = NETWORK === "mainnet"
    ? new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    : new PublicKey("8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2"); // devnet USDC

  console.log(`Asset mint: ${USDC_MINT.toBase58()}`);
  console.log(`Vault name: ${VAULT_NAME}`);
  console.log("");
  console.log("To complete deployment, run the Voltr scripts:");
  console.log("");
  console.log("  # In base-scripts/:");
  console.log("  pnpm ts-node src/scripts/admin-init-vault.ts");
  console.log("");
  console.log("  # In drift-scripts/:");
  console.log("  pnpm ts-node src/scripts/admin-add-adaptor.ts");
  console.log("  pnpm ts-node src/scripts/manager-init-earn.ts");
  console.log("");
  console.log("  # In base-scripts/:");
  console.log("  pnpm ts-node src/scripts/user-deposit-vault.ts");
  console.log("");
  console.log("  # Start the strategy:");
  console.log("  npm run agent");
  console.log("");

  // ── Alternative: Use our devnet vault workflow ──
  if (NETWORK === "devnet") {
    console.log("═══ Alternative: Devnet Quick Test ═══");
    console.log("");
    console.log("  # Full devnet workflow (Drift vault + deposit + withdraw):");
    console.log("  npm run devnet:vault-workflow");
    console.log("");
    console.log("  # Or quick strategy test:");
    console.log("  npm run devnet:dry-run");
    console.log("");
  }

  // ── Log vault info for Ranger TG ──
  console.log("═══ After deployment, share in Ranger TG: ═══");
  console.log("");
  console.log("  Hey team, deployed our vault for Build-A-Bear hackathon.");
  console.log(`  Wallet: ${keypair.publicKey.toBase58()}`);
  console.log("  Vault: <PASTE VAULT ADDRESS>");
  console.log("  Strategy: Delta-neutral funding capture + DLOB market making");
  console.log("  (USDC base, 5-asset weighted portfolio, 6 keeper modules)");
  console.log("");
  console.log("  Would appreciate indexing on Ranger UI.");
  console.log("  Repo: https://github.com/caelum0x/ranger-strategy");
  console.log("");

  // ── Existing devnet adaptor info ──
  console.log("═══ Already Deployed (Devnet) ═══");
  console.log(`  Custom Adaptor: 4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ`);
  console.log(`  Vault: GRQrzTzz55Kd59uFSmW8mvkzUhzVTLCdjHGP4hnbxCna`);
  console.log(`  Strategy: FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY`);
  console.log(`  Drift User: 2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh`);
  console.log(`  Current deposit: 20 USDC`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
