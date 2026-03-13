/**
 * Export trade history for hackathon submission verification.
 *
 * Exports:
 * 1. Binance CEX trade history CSV
 * 2. Drift on-chain funding rate history
 *
 * Usage:
 *   npx ts-node scripts/export-trades.ts [--start 2026-03-09] [--end 2026-04-06]
 *
 * Required for submission:
 * - Trade history CSV export from exchange (Binance)
 * - On-chain verification via wallet/vault address
 */
import { BinanceManager } from "../src/binance/client";
import { DriftManager } from "../src/drift/client";
import { DriftDataAPI } from "../src/drift/data-api";
import { config } from "../src/config";
import * as fs from "fs";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string, defaultVal: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
  };

  // Hackathon build window: Mar 9 – Apr 6
  const startDate = new Date(getArg("--start", "2026-03-09"));
  const endDate = new Date(getArg("--end", "2026-04-06"));

  console.log("\n=== EXPORTING TRADE HISTORY ===\n");
  console.log(`Period: ${startDate.toDateString()} → ${endDate.toDateString()}`);

  // ── 1. Binance Trade History ─────────────────────────────────────
  console.log("\n--- Binance Trade History ---");
  try {
    const binance = new BinanceManager();
    await binance.initialize();

    const trades = await binance.exportTradeHistory(
      startDate.getTime(),
      endDate.getTime()
    );

    if (trades.length === 0) {
      console.log("No Binance trades found for this period.");
    } else {
      // Write CSV
      const headers = [
        "datetime",
        "asset",
        "symbol",
        "side",
        "amount",
        "price",
        "cost",
        "fee_cost",
        "fee_currency",
        "timestamp",
      ];

      const rows = trades.map((t: any) => [
        t.datetime || "",
        t.asset || "",
        t.symbol || "",
        t.side || "",
        t.amount || "",
        t.price || "",
        t.cost || "",
        t.fee?.cost || "",
        t.fee?.currency || "",
        t.timestamp || "",
      ]);

      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join(
        "\n"
      );

      const filename = `binance_trades_${startDate.toISOString().split("T")[0]}_${endDate.toISOString().split("T")[0]}.csv`;
      fs.writeFileSync(filename, csv);
      console.log(`Exported ${trades.length} trades → ${filename}`);

      // Summary
      const totalVolume = trades.reduce(
        (sum: number, t: any) => sum + (parseFloat(t.cost) || 0),
        0
      );
      const totalFees = trades.reduce(
        (sum: number, t: any) => sum + (parseFloat(t.fee?.cost) || 0),
        0
      );
      console.log(`Total volume: $${totalVolume.toFixed(2)}`);
      console.log(`Total fees: $${totalFees.toFixed(4)}`);
    }

    await binance.shutdown();
  } catch (err) {
    console.error("Binance export failed:", err);
  }

  // ── 2. Drift Funding Rate History ────────────────────────────────
  console.log("\n--- Drift Funding Rate History ---");
  try {
    const dataApi = new DriftDataAPI();

    for (const asset of config.targetAssets) {
      const symbol = `${asset}-PERP`;
      const rates = await dataApi.getFundingRates(symbol, 500);

      // Filter to hackathon window
      const filtered = rates.filter(
        (r) =>
          r.ts * 1000 >= startDate.getTime() &&
          r.ts * 1000 <= endDate.getTime()
      );

      if (filtered.length === 0) {
        console.log(`  ${asset}: No funding rates in window`);
        continue;
      }

      // Write CSV
      const headers = [
        "datetime",
        "asset",
        "funding_rate",
        "oracle_price_twap",
        "mark_price_twap",
        "hourly_rate",
        "annualized_rate",
      ];

      const rows = filtered.map((r) => {
        const hourlyRate =
          r.oraclePriceTwap !== 0 ? r.fundingRate / r.oraclePriceTwap : 0;
        return [
          new Date(r.ts * 1000).toISOString(),
          asset,
          r.fundingRate,
          r.oraclePriceTwap,
          r.markPriceTwap,
          hourlyRate.toFixed(10),
          (hourlyRate * 24 * 365.25 * 100).toFixed(4) + "%",
        ];
      });

      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join(
        "\n"
      );

      const filename = `drift_funding_${asset}_${startDate.toISOString().split("T")[0]}_${endDate.toISOString().split("T")[0]}.csv`;
      fs.writeFileSync(filename, csv);
      console.log(
        `  ${asset}: ${filtered.length} rates → ${filename}`
      );

      // Summary
      const avgRate =
        filtered.reduce((sum, r) => {
          const rate =
            r.oraclePriceTwap !== 0 ? r.fundingRate / r.oraclePriceTwap : 0;
          return sum + rate;
        }, 0) / filtered.length;

      console.log(
        `    Avg hourly rate: ${(avgRate * 100).toFixed(6)}% | Annualized: ${(avgRate * 24 * 365.25 * 100).toFixed(2)}%`
      );
    }
  } catch (err) {
    console.error("Drift funding export failed:", err);
  }

  // ── 3. Drift On-Chain Trades ────────────────────────────────────
  console.log("\n--- Drift On-Chain Trades ---");
  try {
    const dataApi2 = new DriftDataAPI();

    for (const asset of config.targetAssets) {
      const symbol = `${asset}-PERP`;
      const trades = await dataApi2.getTrades(symbol, 200);

      const filtered = trades.filter(
        (t) =>
          t.ts * 1000 >= startDate.getTime() &&
          t.ts * 1000 <= endDate.getTime()
      );

      if (filtered.length === 0) {
        console.log(`  ${asset}: No on-chain trades in window`);
        continue;
      }

      const headers = [
        "datetime",
        "asset",
        "direction",
        "base_amount",
        "quote_amount",
        "oracle_price",
        "fee",
        "action",
      ];

      const rows = filtered.map((t) => [
        new Date(t.ts * 1000).toISOString(),
        asset,
        t.direction,
        t.baseAssetAmount,
        t.quoteAssetAmount,
        t.oraclePrice,
        t.fee,
        t.actionExplanation,
      ]);

      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join(
        "\n"
      );

      const filename = `drift_trades_${asset}_${startDate.toISOString().split("T")[0]}_${endDate.toISOString().split("T")[0]}.csv`;
      fs.writeFileSync(filename, csv);
      console.log(`  ${asset}: ${filtered.length} trades → ${filename}`);
    }
  } catch (err) {
    console.error("Drift trade export failed:", err);
  }

  // ── 4. Lending Rate History ───────────────────────────────────────
  console.log("\n--- Drift Lending Rate History ---");
  try {
    const dataApi3 = new DriftDataAPI();

    for (const asset of config.targetAssets) {
      const rates = await dataApi3.getDepositRateHistory(asset, 200);

      if (rates.length === 0) {
        console.log(`  ${asset}: No lending rate data`);
        continue;
      }

      const headers = ["datetime", "asset", "deposit_rate_annualized"];
      const rows = rates.map((r) => [
        new Date(r.ts * 1000).toISOString(),
        asset,
        (r.rate * 100).toFixed(4) + "%",
      ]);

      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join(
        "\n"
      );

      const filename = `drift_lending_${asset}_${startDate.toISOString().split("T")[0]}_${endDate.toISOString().split("T")[0]}.csv`;
      fs.writeFileSync(filename, csv);
      console.log(`  ${asset}: ${rates.length} rates → ${filename}`);

      const avgRate =
        rates.reduce((s, r) => s + r.rate, 0) / rates.length;
      console.log(`    Avg lending APY: ${(avgRate * 100).toFixed(2)}%`);
    }
  } catch (err) {
    console.error("Lending rate export failed:", err);
  }

  // ── 5. Wallet Info ───────────────────────────────────────────────
  console.log("\n--- On-Chain Verification ---");
  const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;
  if (keypairSource) {
    try {
      const drift = new DriftManager({ keypair: keypairSource });
      await drift.initialize();
      console.log(`Wallet: ${drift.getWallet().publicKey.toBase58()}`);

      if (process.env.DRIFT_VAULT_PUBKEY) {
        console.log(`Drift Vault: ${process.env.DRIFT_VAULT_PUBKEY}`);
      }
      if (process.env.VAULT_PUBKEY) {
        console.log(`Ranger Vault: ${process.env.VAULT_PUBKEY}`);
      }

      console.log(
        `Solscan: https://solscan.io/account/${drift.getWallet().publicKey.toBase58()}`
      );

      await drift.shutdown();
    } catch {
      console.log("Could not load wallet info");
    }
  }

  console.log("\n=== EXPORT COMPLETE ===");
  console.log("\nFor hackathon submission, include:");
  console.log("  1. Binance trade CSV (if cross-venue mode)");
  console.log("  2. Drift funding rate CSVs");
  console.log("  3. Drift on-chain trade CSVs");
  console.log("  4. Drift lending rate CSVs");
  console.log("  5. Wallet/vault addresses for on-chain verification");
}

main().catch(console.error);
