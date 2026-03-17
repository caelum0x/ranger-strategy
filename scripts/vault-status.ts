import { VoltrClient } from "@voltr/vault-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const connection = new Connection(
    process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
  );
  const client = new VoltrClient(connection);

  const vaultPubkey = new PublicKey(
    process.env.VAULT_PUBKEY || ""
  );

  if (!process.env.VAULT_PUBKEY) {
    console.error("Error: VAULT_PUBKEY not set in .env");
    process.exit(1);
  }

  console.log("Fetching vault status...\n");

  // Fetch vault account
  const vault = await client.fetchVaultAccount(vaultPubkey);

  // Get position values
  const { totalValue, strategies } =
    await client.getPositionAndTotalValuesForVault(vaultPubkey);

  // Get share price
  const sharePrice = await client.getCurrentAssetPerLpForVault(vaultPubkey);

  // Get fees
  const managerFees = await client.getAccumulatedManagerFeesForVault(vaultPubkey);
  const adminFees = await client.getAccumulatedAdminFeesForVault(vaultPubkey);

  // Get high water mark
  const hwm = await client.getHighWaterMarkForVault(vaultPubkey);

  // Get LP supply breakdown
  const lpBreakdown = await client.getVaultLpSupplyBreakdown(vaultPubkey);

  // Get pending withdrawals
  const pendingWithdrawals = await client.getAllPendingWithdrawalsForVault(vaultPubkey);

  console.log("=== VAULT STATUS ===");
  console.log(`Name: ${vault.name}`);
  console.log(`Description: ${vault.description}`);
  console.log(`Vault: ${vaultPubkey.toBase58()}`);
  console.log(`Asset Mint: ${vault.asset.mint.toBase58()}`);
  console.log(`Admin: ${vault.admin.toBase58()}`);
  console.log(`Manager: ${vault.manager.toBase58()}`);
  console.log("");

  console.log("--- Financials ---");
  console.log(`Total Value: $${(totalValue / 1e6).toFixed(2)}`);
  console.log(`Share Price (asset/LP): ${sharePrice.toString()}`);
  console.log("");

  console.log("--- High Water Mark ---");
  console.log(`Highest Asset/LP: ${hwm.highestAssetPerLp}`);
  console.log(`Last Updated: ${new Date(hwm.lastUpdatedTs * 1000).toISOString()}`);
  console.log("");

  console.log("--- LP Supply ---");
  console.log(`Circulating: ${lpBreakdown.circulating.toString()}`);
  console.log(`Unharvested Fees: ${lpBreakdown.unharvestedFees.toString()}`);
  console.log(`Unrealised Fees: ${lpBreakdown.unrealisedFees.toString()}`);
  console.log(`Total LP: ${lpBreakdown.total.toString()}`);
  console.log("");

  console.log("--- Fees ---");
  console.log(`Manager Fees (LP): ${managerFees.toString()}`);
  console.log(`Admin Fees (LP): ${adminFees.toString()}`);
  console.log("");

  console.log("--- Configuration ---");
  console.log(
    `Max Cap: ${vault.vaultConfiguration.maxCap.toString()}`
  );
  console.log(
    `Withdrawal Waiting Period: ${vault.vaultConfiguration.withdrawalWaitingPeriod.toString()}s`
  );
  console.log(
    `Locked Profit Degradation: ${vault.vaultConfiguration.lockedProfitDegradationDuration.toString()}s`
  );
  console.log(
    `Manager Performance Fee: ${vault.feeConfiguration.managerPerformanceFee / 100}%`
  );
  console.log(
    `Admin Performance Fee: ${vault.feeConfiguration.adminPerformanceFee / 100}%`
  );
  console.log(
    `Manager Management Fee: ${vault.feeConfiguration.managerManagementFee / 100}%`
  );
  console.log(
    `Admin Management Fee: ${vault.feeConfiguration.adminManagementFee / 100}%`
  );
  console.log(
    `Redemption Fee: ${vault.feeConfiguration.redemptionFee / 100}%`
  );
  console.log(
    `Issuance Fee: ${vault.feeConfiguration.issuanceFee / 100}%`
  );
  console.log("");

  console.log("--- Strategies ---");
  console.log(`Active strategies: ${strategies.length}`);
  for (const strat of strategies) {
    console.log(`  - ${JSON.stringify(strat)}`);
  }
  console.log("");

  console.log("--- Pending Withdrawals ---");
  console.log(`Total pending: ${pendingWithdrawals.length}`);
  for (const w of pendingWithdrawals) {
    console.log(`  - User: ${w.user?.toBase58() ?? "?"}, Amount: ${w.amountAssetToWithdrawEffective?.toString() ?? "?"}`);
  }

  // Also fetch from REST API for additional data
  try {
    const apiUrl = process.env.RANGER_API_URL || "https://api.voltr.xyz";
    const response = await fetch(`${apiUrl}/vault/${vaultPubkey.toBase58()}`);
    const apiData = (await response.json()) as any;
    console.log("\n--- API Data ---");
    console.log(`APY: ${apiData.apy || "N/A"}`);
    console.log(`TVL: ${apiData.tvl || "N/A"}`);
  } catch {
    console.log("\n(Could not fetch additional data from API — vault may not be indexed)");
  }
}

main().catch(console.error);
