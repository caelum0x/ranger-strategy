/**
 * Drift account monitor — shows positions, funding, health, and open orders.
 * Usage: npx ts-node scripts/drift-status.ts
 */
import { DriftManager } from "../src/drift/client";
import { DriftFundingAnalyzer } from "../src/drift/funding";
import { DriftDataAPI } from "../src/drift/data-api";
import { DriftVaultManager } from "../src/drift/vault";
import { PublicKey } from "@solana/web3.js";
import { config } from "../src/config";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;
  if (!keypairSource) {
    console.error("Error: Set ANCHOR_WALLET or SOLANA_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const drift = new DriftManager({ keypair: keypairSource });
  await drift.initialize();

  const client = drift.getClient();
  const analyzer = new DriftFundingAnalyzer(client);
  const dataApi = new DriftDataAPI();

  console.log("\n=== DRIFT ACCOUNT STATUS ===\n");

  // Account health
  const healthRatio = await drift.getHealthRatio();
  const freeCollateral = drift.getFreeCollateral();
  const fundingPnl = drift.getUnrealizedFundingPnl();

  console.log("--- Account Health ---");
  console.log(`Health Ratio: ${healthRatio.toFixed(4)}`);
  console.log(`Free Collateral: $${freeCollateral.toFixed(2)}`);
  console.log(`Unrealized Funding PnL: $${fundingPnl.toFixed(4)}`);

  // Positions
  const positions = await drift.getPositions();
  console.log(`\n--- Positions (${positions.length}) ---`);
  for (const p of positions) {
    console.log(
      `  ${p.asset} ${p.side} | size: ${p.size.toFixed(6)} | notional: $${p.notionalValue.toFixed(2)} | pnl: $${p.unrealizedPnl.toFixed(4)}`
    );
  }

  // Open orders
  const openOrders = drift.getOpenOrders();
  console.log(`\n--- Open Orders (${openOrders.length}) ---`);
  for (const o of openOrders) {
    console.log(
      `  #${o.orderId} | ${o.marketIndex} | ${o.direction} | base: ${o.baseAssetAmount?.toString()} | price: ${o.price?.toString()}`
    );
  }

  // Funding analysis
  console.log("\n--- On-Chain Funding Analysis ---");
  const analyses = analyzer.analyzeAllAssets();
  for (const a of analyses) {
    console.log(
      `  ${a.asset}: ${a.annualizedRate.mul(100).toFixed(2)}% APY | premium: ${a.premium.mul(100).toFixed(4)}% | imbalance: ${a.longShortImbalance.mul(100).toFixed(1)}% | ${a.predictedDirection} (${a.confidence.mul(100).toFixed(0)}% conf) | attractive: ${a.isAttractive}`
    );
  }

  // Data API: funding-borrow spread
  console.log("\n--- Funding-Borrow Spread (net yield) ---");
  for (const asset of config.targetAssets) {
    try {
      const spread = await dataApi.getFundingBorrowSpread(asset);
      console.log(`  ${asset}: ${spread.mul(100).toFixed(2)}% net APY`);
    } catch {
      console.log(`  ${asset}: N/A`);
    }
  }

  // Oracle prices
  console.log("\n--- Oracle Prices ---");
  for (const asset of config.targetAssets) {
    const price = await drift.getOraclePrice(asset);
    console.log(`  ${asset}: $${price.toFixed(2)}`);
  }

  // Drift Vault status (if configured)
  const driftVaultPubkey = process.env.DRIFT_VAULT_PUBKEY;
  if (driftVaultPubkey) {
    console.log("\n--- Drift Vault ---");
    try {
      const vaultManager = new DriftVaultManager(client, drift.getWallet());
      await vaultManager.initialize();

      const vaultAddress = new PublicKey(driftVaultPubkey);
      const vaultInfo = await vaultManager.getVault(vaultAddress);
      const equity = await vaultManager.getVaultEquity(vaultAddress);
      const depositors = await vaultManager.getDepositors(vaultAddress);

      console.log(`  Name:          ${vaultInfo.name}`);
      console.log(`  Address:       ${vaultAddress.toBase58()}`);
      console.log(`  Manager:       ${vaultInfo.manager.toBase58()}`);
      console.log(`  Delegate:      ${vaultInfo.delegate.toBase58()}`);
      console.log(`  User (Drift):  ${vaultInfo.user.toBase58()}`);
      console.log(`  Equity:        $${equity.toFixed(2)}`);
      console.log(`  Depositors:    ${depositors.length}`);
      console.log(`  Redeem Period: ${vaultInfo.redeemPeriod}s (${(vaultInfo.redeemPeriod / 86400).toFixed(1)}d)`);
      console.log(`  Profit Share:  ${vaultInfo.profitShare / 100}%`);

      // Withdrawal risk check
      const risk = await vaultManager.checkWithdrawalRisk(vaultAddress);
      const withdrawStr = `$${risk.totalWithdrawRequested.toFixed(2)}`;
      console.log(`  Withdraw Req:  ${withdrawStr} (${risk.withdrawRatio.mul(100).toFixed(1)}% of equity)`);
      if (risk.atRisk) {
        console.log(`  ⚠ WARNING: High withdrawal ratio — reduce positions before redemption!`);
      }

      await vaultManager.shutdown();
    } catch (err) {
      console.log(`  Error: ${err}`);
    }
  }

  await drift.shutdown();
}

main().catch(console.error);
