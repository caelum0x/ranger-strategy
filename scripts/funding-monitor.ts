/**
 * Real-time funding rate monitor with Telegram alerts.
 *
 * Polls Drift Data API every 5 minutes and alerts when:
 * - Funding rate crosses the MIN_FUNDING_APY threshold (opportunity)
 * - Funding rate flips direction (regime change)
 * - Extreme funding spikes > 50% APY (high-conviction signal)
 *
 * Usage:
 *   npx ts-node scripts/funding-monitor.ts
 *   npx ts-node scripts/funding-monitor.ts --assets SOL,BTC,ETH,JTO,BERA
 *   npx ts-node scripts/funding-monitor.ts --interval 120  # 2 minutes
 */
import dotenv from "dotenv";
dotenv.config();

import { DriftDataAPI } from "../src/drift/data-api";
import { TelegramAlerter } from "../src/alerts/telegram";
import { config } from "../src/config";

const POLL_INTERVAL_MS = parseInt(process.argv.find((a) => a.startsWith("--interval="))?.split("=")[1] || "300") * 1000;
const ASSETS = (
  process.argv.find((a) => a.startsWith("--assets="))?.split("=")[1] ||
  "SOL,BTC,ETH,JTO,BERA,INJ,TNSR,HNT,TAO,PYTH"
).split(",");

const EXTREME_FUNDING_THRESHOLD = 0.50; // 50% APY

interface AssetState {
  lastDirection: "positive" | "negative" | null;
  lastAPY: number;
  lastAlertTs: number;
  consecutiveSameDirection: number;
}

const state: Record<string, AssetState> = {};
for (const asset of ASSETS) {
  state[asset] = {
    lastDirection: null,
    lastAPY: 0,
    lastAlertTs: 0,
    consecutiveSameDirection: 0,
  };
}

const api = new DriftDataAPI();
const telegram = new TelegramAlerter();
const minAPY = config.minFundingAPY.toNumber();

function formatAPY(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(6)}%`;
}

async function checkFundingRates(): Promise<void> {
  const now = Date.now();
  const results: Array<{
    asset: string;
    hourlyRate: number;
    annualizedAPY: number;
    direction: "positive" | "negative";
    premium: number;
  }> = [];

  for (const asset of ASSETS) {
    try {
      const symbol = `${asset}-PERP`;
      const rates = await api.getFundingRates(symbol, 1);
      if (rates.length === 0) continue;

      const entry = rates[0];
      const hourlyRate =
        entry.oraclePriceTwap !== 0
          ? entry.fundingRate / entry.oraclePriceTwap
          : entry.fundingRate;

      const annualizedAPY = Math.abs(hourlyRate) * 24 * 365.25;
      const direction: "positive" | "negative" =
        hourlyRate >= 0 ? "positive" : "negative";
      const premium =
        entry.oraclePriceTwap !== 0
          ? (entry.markPriceTwap - entry.oraclePriceTwap) /
            entry.oraclePriceTwap
          : 0;

      results.push({
        asset,
        hourlyRate,
        annualizedAPY,
        direction,
        premium,
      });

      const s = state[asset];

      // Check for direction flip
      if (s.lastDirection && s.lastDirection !== direction) {
        const msg = `${asset} funding flipped: ${s.lastDirection} -> ${direction}\nNew APY: ${formatAPY(annualizedAPY)}\nPrevious APY: ${formatAPY(s.lastAPY)}`;
        console.log(`[FLIP] ${msg}`);
        await telegram.alert("warn", msg);
        s.consecutiveSameDirection = 1;
      } else {
        s.consecutiveSameDirection++;
      }

      // Check for crossing threshold (opportunity)
      if (
        annualizedAPY >= minAPY &&
        s.lastAPY < minAPY &&
        now - s.lastAlertTs > 3600_000 // max 1 alert per hour per asset
      ) {
        const msg = `${asset} funding crossed threshold!\nAPY: ${formatAPY(annualizedAPY)} (min: ${formatAPY(minAPY)})\nDirection: ${direction} (${direction === "positive" ? "short perp collects" : "long perp collects"})\nConsecutive hours: ${s.consecutiveSameDirection}\nMark-Oracle premium: ${formatRate(premium)}`;
        console.log(`[OPPORTUNITY] ${msg}`);
        await telegram.alert("info", msg);
        s.lastAlertTs = now;
      }

      // Check for extreme funding (high conviction)
      if (
        annualizedAPY >= EXTREME_FUNDING_THRESHOLD &&
        now - s.lastAlertTs > 1800_000 // 30 min cooldown for extreme
      ) {
        const msg = `EXTREME funding on ${asset}!\nAPY: ${formatAPY(annualizedAPY)}\nHourly rate: ${formatRate(hourlyRate)}\nDirection: ${direction}\nThis is ${(annualizedAPY / minAPY).toFixed(1)}x the minimum threshold`;
        console.log(`[EXTREME] ${msg}`);
        await telegram.alert("critical", msg);
        s.lastAlertTs = now;
      }

      s.lastDirection = direction;
      s.lastAPY = annualizedAPY;
    } catch (err) {
      console.error(`Failed to fetch ${asset}:`, err);
    }
  }

  // Print summary table
  console.log(`\n[${new Date().toISOString()}] Funding Rate Summary`);
  console.log(
    "─".repeat(80)
  );
  console.log(
    `${"Asset".padEnd(8)} ${"Hourly Rate".padEnd(14)} ${"APY".padEnd(12)} ${"Direction".padEnd(12)} ${"Premium".padEnd(12)} ${"Streak".padEnd(8)} ${"Signal".padEnd(10)}`
  );
  console.log(
    "─".repeat(80)
  );

  // Sort by APY descending
  results.sort((a, b) => b.annualizedAPY - a.annualizedAPY);

  for (const r of results) {
    const s = state[r.asset];
    const signal =
      r.annualizedAPY >= EXTREME_FUNDING_THRESHOLD
        ? "EXTREME"
        : r.annualizedAPY >= minAPY
          ? "ACTIVE"
          : "skip";

    console.log(
      `${r.asset.padEnd(8)} ${formatRate(r.hourlyRate).padEnd(14)} ${formatAPY(r.annualizedAPY).padEnd(12)} ${r.direction.padEnd(12)} ${formatRate(r.premium).padEnd(12)} ${String(s.consecutiveSameDirection).padEnd(8)} ${signal.padEnd(10)}`
    );
  }

  // Show top opportunities
  const opportunities = results.filter((r) => r.annualizedAPY >= minAPY);
  if (opportunities.length > 0) {
    console.log(
      `\nTop opportunities (>${formatAPY(minAPY)} APY): ${opportunities.map((o) => `${o.asset} (${formatAPY(o.annualizedAPY)})`).join(", ")}`
    );
  } else {
    console.log(
      `\nNo assets above ${formatAPY(minAPY)} APY threshold`
    );
  }
}

async function main() {
  console.log("Funding Rate Monitor");
  console.log(`Assets: ${ASSETS.join(", ")}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Min APY threshold: ${formatAPY(minAPY)}`);
  console.log(`Extreme threshold: ${formatAPY(EXTREME_FUNDING_THRESHOLD)}`);
  console.log(
    `Telegram: ${telegram ? "configured" : "disabled"}`
  );
  console.log("");

  // Initial check
  await checkFundingRates();

  // Continuous polling
  setInterval(async () => {
    try {
      await checkFundingRates();
    } catch (err) {
      console.error("Monitor error:", err);
    }
  }, POLL_INTERVAL_MS);
}

main().catch(console.error);
