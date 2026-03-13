/**
 * Initialize a Drift Protocol vault for the delta-neutral strategy.
 *
 * Usage: npx ts-node scripts/init-drift-vault.ts [--name "MyVault"] [--redeem-period 604800]
 *
 * Steps:
 * 1. Creates vault on Drift Vaults program
 * 2. Sets the agent wallet as delegate
 * 3. Enables margin trading
 * 4. Manager deposits initial USDC
 */
import { DriftManager } from "../src/drift/client";
import { DriftVaultManager } from "../src/drift/vault";
import { config } from "../src/config";
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

  const vaultName = getArg("--name", "RangerDeltaNeutral");
  const redeemPeriod = parseInt(getArg("--redeem-period", "604800")); // 7 days
  const managementFee = parseInt(getArg("--management-fee", "200")); // 2%
  const profitShare = parseInt(getArg("--profit-share", "2000")); // 20%
  const initialDeposit = parseFloat(getArg("--deposit", "0")); // USDC

  console.log(`\n=== INITIALIZING DRIFT VAULT ===\n`);
  console.log(`Name:           ${vaultName}`);
  console.log(`Redeem Period:  ${redeemPeriod}s (${(redeemPeriod / 86400).toFixed(1)} days)`);
  console.log(`Management Fee: ${managementFee} bps (${(managementFee / 100).toFixed(1)}%)`);
  console.log(`Profit Share:   ${profitShare / 100}%`);
  if (initialDeposit > 0) {
    console.log(`Initial Deposit: $${initialDeposit.toFixed(2)} USDC`);
  }
  console.log();

  // Initialize Drift client
  const drift = new DriftManager({ keypair: keypairSource });
  await drift.initialize();

  const driftClient = drift.getClient();
  const wallet = drift.getWallet();

  // Initialize vault manager
  const vaultManager = new DriftVaultManager(driftClient, wallet);
  await vaultManager.initialize();

  // Step 1: Create vault
  console.log("Step 1: Creating vault...");
  const { vaultAddress, txSig } = await vaultManager.initializeVault({
    name: vaultName,
    spotMarketIndex: 0, // USDC
    redeemPeriod,
    managementFee,
    profitShare,
    maxTokens: 0, // unlimited
    permissioned: false,
  });
  console.log(`  Vault created: ${vaultAddress.toBase58()}`);
  console.log(`  Tx: ${txSig}`);

  // Step 2: Set delegate (agent wallet = manager = delegate for hackathon)
  console.log("\nStep 2: Setting delegate...");
  const delegateTx = await vaultManager.updateDelegate(
    vaultAddress,
    wallet.publicKey
  );
  console.log(`  Delegate set to: ${wallet.publicKey.toBase58()}`);
  console.log(`  Tx: ${delegateTx}`);

  // Step 3: Enable margin trading
  console.log("\nStep 3: Enabling margin trading...");
  const marginTx = await vaultManager.enableMarginTrading(vaultAddress);
  console.log(`  Margin trading enabled`);
  console.log(`  Tx: ${marginTx}`);

  // Step 4: Manager deposit (optional)
  if (initialDeposit > 0) {
    console.log(`\nStep 4: Manager depositing $${initialDeposit.toFixed(2)} USDC...`);
    const depositTx = await vaultManager.managerDeposit(
      vaultAddress,
      new Decimal(initialDeposit)
    );
    console.log(`  Deposit completed`);
    console.log(`  Tx: ${depositTx}`);
  }

  // Show vault status
  console.log("\n=== VAULT CREATED SUCCESSFULLY ===\n");
  const vaultInfo = await vaultManager.getVault(vaultAddress);
  console.log(`Vault Address:  ${vaultInfo.address.toBase58()}`);
  console.log(`Name:           ${vaultInfo.name}`);
  console.log(`Manager:        ${vaultInfo.manager.toBase58()}`);
  console.log(`Delegate:       ${vaultInfo.delegate.toBase58()}`);
  console.log(`Drift User:     ${vaultInfo.user.toBase58()}`);

  const equity = await vaultManager.getVaultEquity(vaultAddress);
  console.log(`Equity:         $${equity.toFixed(2)} USDC`);

  console.log(`\nSave this vault address in your .env:`);
  console.log(`  DRIFT_VAULT_PUBKEY=${vaultAddress.toBase58()}`);
  console.log(`\nTo trade as vault delegate, the agent uses this vault's Drift user account`);
  console.log(`as authority. This is handled automatically by the agent.`);

  await vaultManager.shutdown();
  await drift.shutdown();
}

main().catch((err) => {
  console.error("Failed to initialize vault:", err);
  process.exit(1);
});
