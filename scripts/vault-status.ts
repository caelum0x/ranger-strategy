import { VoltrClient } from "@voltr/vault-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
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
    await client.getPositionAndTotalValuesForVault(vault);

  // Get share price
  const sharePrice = await client.getCurrentAssetPerLpForVault(vault);

  // Get fees
  const managerFees = await client.getAccumulatedManagerFeesForVault(vault);

  console.log("=== VAULT STATUS ===");
  console.log(`Name: ${vault.name}`);
  console.log(`Description: ${vault.description}`);
  console.log(`Vault: ${vaultPubkey.toBase58()}`);
  console.log(`Asset Mint: ${vault.asset.mint.toBase58()}`);
  console.log("");
  console.log("--- Financials ---");
  console.log(`Total Value: $${(totalValue.toNumber() / 1e6).toFixed(2)}`);
  console.log(`Share Price: ${sharePrice.toString()}`);
  console.log(`Manager Fees Accumulated: ${managerFees.toString()}`);
  console.log("");
  console.log("--- Configuration ---");
  console.log(
    `Max Cap: ${vault.vaultConfiguration.maxCap.toString()}`
  );
  console.log(
    `Withdrawal Waiting Period: ${vault.vaultConfiguration.withdrawalWaitingPeriod.toString()}s`
  );
  console.log(
    `Manager Performance Fee: ${vault.feeConfiguration.managerPerformanceFee / 100}%`
  );
  console.log(
    `Manager Management Fee: ${vault.feeConfiguration.managerManagementFee / 100}%`
  );
  console.log("");
  console.log("--- Strategies ---");
  console.log(`Active strategies: ${strategies.length}`);
  for (const strat of strategies) {
    console.log(`  - ${JSON.stringify(strat)}`);
  }

  // Also fetch from REST API for additional data
  try {
    const apiUrl = process.env.RANGER_API_URL || "https://api.voltr.xyz";
    const response = await fetch(`${apiUrl}/vault/${vaultPubkey.toBase58()}`);
    const apiData = await response.json();
    console.log("\n--- API Data ---");
    console.log(`APY: ${apiData.apy || "N/A"}`);
    console.log(`TVL: ${apiData.tvl || "N/A"}`);
  } catch {
    console.log("\n(Could not fetch additional data from API)");
  }
}

main().catch(console.error);
