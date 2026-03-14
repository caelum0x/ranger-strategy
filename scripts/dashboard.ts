/**
 * Unified monitoring dashboard — shows all key metrics in one view.
 * Usage: npx ts-node scripts/dashboard.ts
 *
 * Displays:
 * - Account health, collateral, leverage
 * - Open positions (spot + perp)
 * - Funding rates with on-chain analysis
 * - Lending rates on spot deposits
 * - Vault status (if configured)
 * - P&L breakdown
 * - Risk assessment
 */
import { DriftManager } from "../src/drift/client";
import { DriftFundingAnalyzer } from "../src/drift/funding";
import { DriftDataAPI } from "../src/drift/data-api";
import { DriftVaultManager } from "../src/drift/vault";
import { TradeLogger } from "../src/utils/trade-logger";
import { StateStore } from "../src/utils/state-store";
import { VaultPerformanceTracker } from "../src/vault/performance";
import { PublicKey } from "@solana/web3.js";
import { config } from "../src/config";
import Decimal from "decimal.js";
import dotenv from "dotenv";

dotenv.config();

function divider(title: string) {
  const pad = Math.max(0, 56 - title.length - 4);
  console.log(`\n--- ${title} ${"─".repeat(pad)}`);
}

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

  console.log("=".repeat(60));
  console.log("  RANGER DELTA-NEUTRAL VAULT — DASHBOARD");
  console.log(`  ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  // ── Account Overview ──────────────────────────────────────────
  divider("Account Overview");
  const healthRatio = await drift.getHealthRatio();
  const freeCollateral = drift.getFreeCollateral();
  const fundingPnl = drift.getUnrealizedFundingPnl();

  const healthColor =
    healthRatio.lt(1.1) ? "CRITICAL" :
    healthRatio.lt(1.5) ? "WARNING" :
    "HEALTHY";

  console.log(`  Health Ratio:     ${healthRatio.toFixed(4)} (${healthColor})`);
  console.log(`  Free Collateral:  $${freeCollateral.toFixed(2)}`);
  console.log(`  Funding PnL:      $${fundingPnl.toFixed(4)}`);
  console.log(`  Wallet:           ${drift.getWallet().publicKey.toBase58()}`);

  // ── Positions ─────────────────────────────────────────────────
  const positions = await drift.getPositions();
  divider(`Positions (${positions.length})`);

  let totalNotional = new Decimal(0);
  let totalPnl = new Decimal(0);

  if (positions.length === 0) {
    console.log("  No open positions");
  } else {
    for (const p of positions) {
      const pnlStr = p.unrealizedPnl.gte(0)
        ? `+$${p.unrealizedPnl.toFixed(4)}`
        : `-$${p.unrealizedPnl.abs().toFixed(4)}`;
      console.log(
        `  ${p.asset.padEnd(4)} ${p.side.padEnd(5)} ${p.venue.padEnd(7)} | ` +
        `size: ${p.size.toFixed(6)} | ` +
        `notional: $${p.notionalValue.toFixed(2)} | ` +
        `PnL: ${pnlStr}`
      );
      totalNotional = totalNotional.add(p.notionalValue);
      totalPnl = totalPnl.add(p.unrealizedPnl);
    }
    console.log(`  ${"─".repeat(55)}`);
    console.log(`  Total notional: $${totalNotional.toFixed(2)} | Total PnL: $${totalPnl.toFixed(4)}`);
  }

  // ── Delta Neutrality Check ────────────────────────────────────
  divider("Delta Neutrality");
  const assetDeltas: Record<string, { long: Decimal; short: Decimal }> = {};
  for (const p of positions) {
    if (!assetDeltas[p.asset]) {
      assetDeltas[p.asset] = { long: new Decimal(0), short: new Decimal(0) };
    }
    if (p.side === "long") {
      assetDeltas[p.asset].long = assetDeltas[p.asset].long.add(p.notionalValue);
    } else {
      assetDeltas[p.asset].short = assetDeltas[p.asset].short.add(p.notionalValue);
    }
  }

  for (const [asset, delta] of Object.entries(assetDeltas)) {
    const netDelta = delta.long.sub(delta.short);
    const totalPair = delta.long.add(delta.short);
    const pct = totalPair.isZero()
      ? new Decimal(0)
      : netDelta.div(totalPair).mul(100);
    const status = pct.abs().gt(5) ? "IMBALANCED" : "OK";
    console.log(
      `  ${asset}: long $${delta.long.toFixed(2)} | short $${delta.short.toFixed(2)} | ` +
      `net: $${netDelta.toFixed(2)} (${pct.toFixed(1)}%) [${status}]`
    );
  }

  // ── Funding Rates ─────────────────────────────────────────────
  divider("Funding Analysis (On-Chain)");
  const analyses = analyzer.analyzeAllAssets();
  for (const a of analyses) {
    const dir = a.attractiveDirection
      ? `→ ${a.attractiveDirection} perp`
      : "none";
    console.log(
      `  ${a.asset.padEnd(4)} ${(a.annualizedRate.mul(100).toFixed(2) + "%").padEnd(8)} | ` +
      `premium: ${(a.premium.mul(100).toFixed(3) + "%").padEnd(8)} | ` +
      `imbalance: ${(a.longShortImbalance.mul(100).toFixed(1) + "%").padEnd(7)} | ` +
      `momentum: ${a.momentum.padEnd(7)} | ` +
      `conf: ${(a.confidence.mul(100).toFixed(0) + "%").padEnd(4)} | ` +
      `${a.isAttractive ? "ATTRACTIVE" : "skip"} ${dir}`
    );
  }

  // ── Lending Rates ─────────────────────────────────────────────
  divider("Spot Lending Rates");
  for (const asset of config.targetAssets) {
    try {
      const rates = await dataApi.getDepositRateHistory(asset, 1);
      if (rates.length > 0) {
        console.log(`  ${asset}: ${(rates[0].rate * 100).toFixed(2)}% deposit APY`);
      } else {
        console.log(`  ${asset}: N/A`);
      }
    } catch {
      console.log(`  ${asset}: N/A`);
    }
  }

  // ── Funding-Borrow Spread ─────────────────────────────────────
  divider("Net Yield (Funding - Borrow)");
  for (const asset of config.targetAssets) {
    try {
      const spread = await dataApi.getFundingBorrowSpread(asset);
      console.log(`  ${asset}: ${spread.mul(100).toFixed(2)}% net APY`);
    } catch {
      console.log(`  ${asset}: N/A`);
    }
  }

  // ── Open Orders ───────────────────────────────────────────────
  const openOrders = drift.getOpenOrders();
  divider(`Open Orders (${openOrders.length})`);
  if (openOrders.length === 0) {
    console.log("  No open orders");
  } else {
    for (const o of openOrders) {
      console.log(
        `  #${o.orderId} | mkt: ${o.marketIndex} | ` +
        `${o.direction} | base: ${o.baseAssetAmount?.toString()} | ` +
        `price: ${o.price?.toString()}`
      );
    }
  }

  // ── Drift Vault ───────────────────────────────────────────────
  const driftVaultPubkey = process.env.DRIFT_VAULT_PUBKEY;
  if (driftVaultPubkey) {
    divider("Drift Vault");
    try {
      const vaultManager = new DriftVaultManager(client, drift.getWallet());
      await vaultManager.initialize();

      const vaultAddress = new PublicKey(driftVaultPubkey);
      const vaultInfo = await vaultManager.getVault(vaultAddress);
      const equity = await vaultManager.getVaultEquity(vaultAddress);
      const depositors = await vaultManager.getDepositors(vaultAddress);
      const risk = await vaultManager.checkWithdrawalRisk(vaultAddress);

      console.log(`  Name:          ${vaultInfo.name}`);
      console.log(`  Address:       ${vaultAddress.toBase58()}`);
      console.log(`  Equity:        $${equity.toFixed(2)}`);
      console.log(`  Depositors:    ${depositors.length}`);
      console.log(`  Redeem Period: ${(vaultInfo.redeemPeriod / 86400).toFixed(1)} days`);
      console.log(`  Profit Share:  ${vaultInfo.profitShare / 100}%`);
      console.log(`  Withdraw Req:  $${risk.totalWithdrawRequested.toFixed(2)} (${risk.withdrawRatio.mul(100).toFixed(1)}%)`);
      if (risk.atRisk) {
        console.log(`  *** WARNING: High withdrawal ratio — reduce positions ***`);
      }

      await vaultManager.shutdown();
    } catch (err) {
      console.log(`  Error: ${err}`);
    }
  }

  // ── Oracle Prices ─────────────────────────────────────────────
  divider("Oracle Prices");
  for (const asset of config.targetAssets) {
    const price = await drift.getOraclePrice(asset);
    console.log(`  ${asset}: $${price.toFixed(2)}`);
  }

  // ── Saved Agent State ───────────────────────────────────────
  divider("Agent State (from disk)");
  const stateStore = new StateStore();
  const savedState = stateStore.load();
  if (savedState) {
    const s = savedState.state;
    const ageMin = Math.round((Date.now() - savedState.savedAt) / 60000);
    console.log(`  Last saved:        ${new Date(savedState.savedAt).toISOString()} (${ageMin}m ago)`);
    console.log(`  Cycle:             #${s.cycleCount || 0}`);
    console.log(`  Regime:            ${s.regime || "unknown"}`);
    console.log(`  Funding collected: $${s.totalFundingCollected?.toFixed(4) || "0"}`);
    console.log(`  Lending collected: $${s.totalLendingCollected?.toFixed(4) || "0"}`);
    console.log(`  Trading costs:     $${s.totalTradingCosts?.toFixed(4) || "0"}`);
    console.log(`  APY estimate:      ${s.apyEstimate?.toFixed(2) || "0"}%`);
    console.log(`  Direction flips:   ${s.directionFlips || 0}`);
    if (savedState.startTime) {
      const runHours = ((savedState.savedAt - savedState.startTime) / 3600000).toFixed(1);
      console.log(`  Runtime:           ${runHours}h`);
    }
  } else {
    console.log("  No saved state — agent hasn't run yet");
  }

  // ── Trade Event Log ─────────────────────────────────────────
  divider("Trade Event Log (recent)");
  const tradeLogger = new TradeLogger();
  const summary = tradeLogger.getSummary();
  if (summary.totalEvents > 0) {
    console.log(`  Total events:      ${summary.totalEvents}`);
    console.log(`  Signals generated: ${summary.totalSignals}`);
    console.log(`  Trades executed:   ${summary.totalExecutions}`);
    console.log(`  Trade failures:    ${summary.totalFailures}`);
    console.log(`  Direction flips:   ${summary.totalFlips}`);
    console.log(`  Regime changes:    ${summary.regimeChanges}`);
    console.log(`  First event:       ${summary.firstEvent}`);
    console.log(`  Last event:        ${summary.lastEvent}`);

    // Show last 5 events
    const recent = tradeLogger.readRecent(5);
    if (recent.length > 0) {
      console.log("");
      console.log("  Last 5 events:");
      for (const event of recent) {
        const time = event.timestamp.split("T")[1].split(".")[0];
        const asset = (event.data.asset as string) || "";
        console.log(`    [${time}] ${event.type.padEnd(18)} ${asset.padEnd(4)} cycle#${event.cycle}`);
      }
    }
  } else {
    console.log("  No trade events recorded yet");
  }

  // ── Vault Performance ─────────────────────────────────────────
  divider("Vault Performance");
  const vaultPerf = new VaultPerformanceTracker();
  const report = vaultPerf.generateReport();
  const navHistory = vaultPerf.getNAVHistory();
  if (navHistory.length > 0) {
    const formatted = vaultPerf.formatReport(report);
    console.log(`  NAV snapshots:     ${navHistory.length}`);
    console.log(`  Current NAV:       ${formatted.currentNAV}`);
    console.log(`  Share price:       ${formatted.sharePrice}`);
    console.log(`  Total return:      ${formatted.totalReturn}`);
    console.log(`  Annualized:        ${formatted.annualizedReturn}`);
    console.log(`  Max drawdown:      ${formatted.maxDrawdown}`);
    console.log(`  Sharpe estimate:   ${formatted.sharpeEstimate}`);
    console.log(`  Depositors:        ${formatted.depositorCount}`);
    console.log(`  Withdraw pressure: ${formatted.withdrawalPressure}`);
    console.log(`  Available liq:     ${formatted.availableLiquidity}`);
    console.log(`  Capital util:      ${formatted.capitalUtilization}`);
    console.log(`  Fees earned:       ${formatted.totalFeesEarned}`);
  } else {
    console.log("  No NAV history — vault hasn't recorded snapshots yet");
  }

  console.log("\n" + "=".repeat(60));
  console.log(`  Dashboard generated at ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  await drift.shutdown();
}

main().catch(console.error);
