/**
 * Deposit USDC into the Drift vault.
 *
 * Usage:
 *   npx ts-node scripts/deposit-strategy.ts --amount 20 [--vault <VAULT_ADDRESS>]
 *
 * Supports both manager deposits and depositor deposits.
 * Default: manager deposit (vault manager adds their own capital).
 */
import { DriftManager } from "../src/drift/client";
import { DriftVaultManager } from "../src/drift/vault";
import { config } from "../src/config";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;
  if (!keypairSource) {
    console.error("Error: Set ANCHOR_WALLET or SOLANA_PRIVATE_KEY in .env");
    process.exit(1);
  }

  // Parse CLI args
  const args = process.argv.slice(2);
  const getArg = (flag: string, defaultVal: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
  };

  const amountStr = getArg("--amount", "0");
  const amount = parseFloat(amountStr);
  if (amount <= 0) {
    console.error("Error: --amount required (e.g., --amount 20)");
    process.exit(1);
  }

  const vaultAddressStr =
    getArg("--vault", "") || process.env.DRIFT_VAULT_PUBKEY || "";
  if (!vaultAddressStr) {
    console.error(
      "Error: Provide --vault <ADDRESS> or set DRIFT_VAULT_PUBKEY in .env"
    );
    process.exit(1);
  }

  const isDepositor = args.includes("--as-depositor");
  const vaultAddress = new PublicKey(vaultAddressStr);

  console.log(`\n=== DEPOSIT TO DRIFT VAULT ===\n`);
  console.log(`Vault:  ${vaultAddress.toBase58()}`);
  console.log(`Amount: $${amount.toFixed(2)} USDC`);
  console.log(`Mode:   ${isDepositor ? "Depositor" : "Manager"}`);
  console.log();

  // Initialize Drift
  const drift = new DriftManager({ keypair: keypairSource });
  await drift.initialize();

  const driftClient = drift.getClient();
  const wallet = drift.getWallet();

  // Initialize vault manager
  const vaultManager = new DriftVaultManager(driftClient, wallet);
  await vaultManager.initialize();

  // Show vault before
  const equityBefore = await vaultManager.getVaultEquity(vaultAddress);
  console.log(`Vault equity before: $${equityBefore.toFixed(2)}`);

  if (isDepositor) {
    // Depositor flow: init depositor account → deposit
    const depositorAddress = vaultManager.getDepositorAddress(
      vaultAddress,
      wallet.publicKey
    );

    // Try to init depositor (may already exist)
    try {
      console.log("Initializing depositor account...");
      await vaultManager.initializeDepositor(vaultAddress);
      console.log(`Depositor: ${depositorAddress.toBase58()}`);
    } catch {
      console.log("Depositor account already exists");
    }

    console.log(`Depositing $${amount.toFixed(2)} USDC...`);
    const txSig = await vaultManager.deposit(
      depositorAddress,
      new Decimal(amount)
    );
    console.log(`Deposit tx: ${txSig}`);
  } else {
    // Manager deposit
    console.log(`Manager depositing $${amount.toFixed(2)} USDC...`);
    const txSig = await vaultManager.managerDeposit(
      vaultAddress,
      new Decimal(amount)
    );
    console.log(`Deposit tx: ${txSig}`);
  }

  // Show vault after
  const equityAfter = await vaultManager.getVaultEquity(vaultAddress);
  console.log(`\nVault equity after: $${equityAfter.toFixed(2)}`);
  console.log(`Change: +$${equityAfter.sub(equityBefore).toFixed(2)}`);

  await vaultManager.shutdown();
  await drift.shutdown();

  console.log("\nDeposit complete.");
}

main().catch((err) => {
  console.error("Deposit failed:", err);
  process.exit(1);
});
