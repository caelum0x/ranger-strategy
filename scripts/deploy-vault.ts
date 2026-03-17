/**
 * Full vault deployment script — creates and initializes a Ranger Earn vault.
 *
 * Uses the @voltr/vault-sdk to:
 *   1. Initialize Voltr vault with USDC base asset
 *   2. Save vault keypair + info for subsequent operations
 *
 * After creation, you still need to:
 *   - Set up LP token metadata
 *   - Initialize strategies (add Drift adaptor, init earn strategy)
 *   - Allocate funds to strategies
 *
 * Usage:
 *   npm run deploy-vault
 *   npm run deploy-vault -- --amount 10 --network mainnet
 *   npm run deploy-vault -- --name "My Vault" --description "Short description"
 *
 * After deployment, share vault address in Ranger TG for indexing.
 */
import { BN } from "@coral-xyz/anchor";
import { VaultConfig, VaultParams, VoltrClient } from "@voltr/vault-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { config } from "../src/config";
import * as fs from "fs";

// ── Parse CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, defaultVal: string) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const NETWORK = getArg("network", "devnet");
const VAULT_NAME = getArg("name", "Delta-Neutral Funding Vault");
const VAULT_DESCRIPTION = getArg("description", "Delta-neutral funding capture + DLOB maker");

// ── Main ────────────────────────────────────────────────────────

async function main() {
  // Validate inputs
  if (VAULT_NAME.length > 32) {
    console.error("ERROR: Vault name must be 32 characters or fewer");
    process.exit(1);
  }
  if (VAULT_DESCRIPTION.length > 64) {
    console.error("ERROR: Vault description must be 64 characters or fewer");
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║       Ranger Earn Vault Deployment                  ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Network:  ${NETWORK.padEnd(41)}║`);
  console.log(`║  Name:     ${VAULT_NAME.padEnd(41)}║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("");

  // ── Load admin keypair ──
  const adminPath = process.env.ADMIN_KEYPAIR_PATH ||
    process.env.ANCHOR_WALLET ||
    (NETWORK === "devnet" ? "./devnet-keypair.json" : undefined);

  if (!adminPath || !fs.existsSync(adminPath)) {
    console.error("ERROR: No admin keypair found. Set ADMIN_KEYPAIR_PATH or ANCHOR_WALLET");
    process.exit(1);
  }

  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf-8")))
  );
  console.log(`Admin:   ${adminKp.publicKey.toBase58()}`);

  // ── Load manager keypair (falls back to admin if not set) ──
  const managerPath = process.env.MANAGER_KEYPAIR_PATH;
  const managerKp = managerPath && fs.existsSync(managerPath)
    ? Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(managerPath, "utf-8")))
      )
    : adminKp;
  console.log(`Manager: ${managerKp.publicKey.toBase58()}`);

  // ── Connect ──
  const rpcUrl = NETWORK === "mainnet"
    ? config.solanaRpcUrl
    : "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  const balance = await connection.getBalance(adminKp.publicKey);
  console.log(`SOL Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.05 * 1e9) {
    if (NETWORK === "devnet") {
      console.log("Airdropping 1 SOL...");
      const sig = await connection.requestAirdrop(adminKp.publicKey, 1e9);
      await connection.confirmTransaction(sig, "confirmed");
    } else {
      console.error("ERROR: Insufficient SOL balance for mainnet deployment");
      process.exit(1);
    }
  }

  // ── Step 1: Configure vault parameters ──
  console.log("\n═══ Step 1: Configure Vault ═══");

  const vaultConfig: VaultConfig = {
    maxCap: new BN("18446744073709551615"),         // Uncapped (u64 max)
    startAtTs: new BN(0),                           // Immediate activation
    lockedProfitDegradationDuration: new BN(86400), // 24 hours
    managerPerformanceFee: 2000,                    // 20% in basis points
    adminPerformanceFee: 0,                         // 0%
    managerManagementFee: 100,                      // 1% in basis points
    adminManagementFee: 0,                          // 0%
    redemptionFee: 10,                              // 0.1% in basis points
    issuanceFee: 10,                                // 0.1% in basis points
    withdrawalWaitingPeriod: new BN(604800),        // 7 days in seconds
  };

  const vaultParams: VaultParams = {
    config: vaultConfig,
    name: VAULT_NAME,
    description: VAULT_DESCRIPTION,
  };

  console.log("  Max cap:            Uncapped (u64 max)");
  console.log("  Performance fee:    20% (manager)");
  console.log("  Management fee:     1% (manager)");
  console.log("  Redemption fee:     0.1%");
  console.log("  Issuance fee:       0.1%");
  console.log("  Withdrawal wait:    7 days");
  console.log("  Profit degradation: 24 hours");

  // ── Step 2: Generate vault keypair ──
  console.log("\n═══ Step 2: Generate Vault Keypair ═══");
  const vaultKp = Keypair.generate();
  console.log(`  Vault address: ${vaultKp.publicKey.toBase58()}`);

  // USDC mint (mainnet or devnet)
  const USDC_MINT = NETWORK === "mainnet"
    ? new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    : new PublicKey("8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2");
  console.log(`  Asset mint:    ${USDC_MINT.toBase58()}`);

  // ── Step 3: Create vault initialization instruction ──
  console.log("\n═══ Step 3: Initialize Vault ═══");
  const client = new VoltrClient(connection);

  const createVaultIx = await client.createInitializeVaultIx(
    vaultParams,
    {
      vault: vaultKp.publicKey,
      vaultAssetMint: USDC_MINT,
      admin: adminKp.publicKey,
      manager: managerKp.publicKey,
      payer: adminKp.publicKey,
    }
  );

  // ── Step 4: Send and confirm the transaction ──
  console.log("  Sending transaction...");
  const tx = new Transaction().add(createVaultIx);

  const txSig = await sendAndConfirmTransaction(
    connection,
    tx,
    [adminKp, vaultKp],
    { commitment: "confirmed" }
  );

  console.log(`  Vault created: ${vaultKp.publicKey.toBase58()}`);
  console.log(`  Transaction:   ${txSig}`);

  // ── Step 5: Save vault info ──
  console.log("\n═══ Step 5: Save Vault Info ═══");

  // Save vault keypair
  const vaultKeypairPath = `./vault-keypair-${NETWORK}.json`;
  fs.writeFileSync(
    vaultKeypairPath,
    JSON.stringify(Array.from(vaultKp.secretKey))
  );
  console.log(`  Vault keypair saved: ${vaultKeypairPath}`);

  // Save vault info
  const vaultInfo = {
    network: NETWORK,
    vaultAddress: vaultKp.publicKey.toBase58(),
    adminAddress: adminKp.publicKey.toBase58(),
    managerAddress: managerKp.publicKey.toBase58(),
    assetMint: USDC_MINT.toBase58(),
    name: VAULT_NAME,
    description: VAULT_DESCRIPTION,
    txSignature: txSig,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync("./vault-info.json", JSON.stringify(vaultInfo, null, 2));
  console.log("  Vault info saved: ./vault-info.json");

  // ── Next steps ──
  console.log("\n═══ Next Steps ═══");
  console.log("");
  console.log("  Your vault is created but won't generate yield yet.");
  console.log("  Deposited funds sit idle until you:");
  console.log("");
  console.log("  1. Set up LP token metadata (so wallets display your token)");
  console.log("  2. Initialize strategies (add Drift adaptor + init earn strategy)");
  console.log("  3. Allocate funds to move idle funds into strategies");
  console.log("");
  console.log("  # Add Drift adaptor + init strategy:");
  console.log("  pnpm ts-node src/scripts/admin-add-adaptor.ts");
  console.log("  pnpm ts-node src/scripts/manager-init-earn.ts");
  console.log("");

  // ── Share in Ranger TG ──
  console.log("═══ Share in Ranger TG for indexing: ═══");
  console.log("");
  console.log("  Hey team, deployed our vault for Build-A-Bear hackathon.");
  console.log(`  Wallet:   ${adminKp.publicKey.toBase58()}`);
  console.log(`  Vault:    ${vaultKp.publicKey.toBase58()}`);
  console.log(`  Strategy: ${VAULT_DESCRIPTION}`);
  console.log("  Would appreciate indexing on Ranger UI.");
  console.log("");

  // ── Save vault pubkey to .env ──
  console.log("═══ Environment ═══");
  console.log(`  Add to .env:`);
  console.log(`  VAULT_PUBKEY=${vaultKp.publicKey.toBase58()}`);
  console.log(`  VOLTR_VAULT_ADDRESS=${vaultKp.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
