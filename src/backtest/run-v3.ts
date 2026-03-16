/**
 * Backtest v3 — Uses bulk paginated endpoint (no day-by-day rate limiting)
 * Real 31-day window: Feb 12 → Mar 15, 2026
 * Assets: SOL, BTC, ETH, JTO, JUP, PYTH, WIF
 * Strategy: top-2 by funding APY, 2x leverage, 3-period flip protection
 */
import Decimal from "decimal.js";
import * as fs from "fs";
import { logger } from "../utils/logger";

// Full universe ranked by 7d avg APY from real Drift data:
// CLOUD 178%, MET 140%, TRUMP 135%, MNT 92%, KMNO 81%, HNT 74%,
// 1KPUMP 73%, 1KMON 70%, BERA 65%, IP 60%, LIT 58%, TON 53%,
// RENDER 52%, TAO 46%, OP 45%, TNSR 42%, POL 41%, INJ 32%, JTO 29%
// Floor assets (min APY > 20%): IP 46.9%, OP 32.9%, RENDER 25.6%, INJ 24.3%, BERA 19.5%
const ASSETS = [
  "CLOUD", "MET", "TRUMP", "MNT", "KMNO", "HNT", "1KPUMP", "1KMON",
  "BERA", "IP", "LIT", "TON", "RENDER", "TAO", "OP", "TNSR",
  "POL", "INJ", "JTO", "PYTH", "SOL"
];
const BASE_URL = "https://data.api.drift.trade";

const TOP_N_ASSETS      = 3;    // top-3 — balances concentration vs diversification
const MIN_FUNDING_APY   = 0.08; // 8% APY floor
const PERP_LEVERAGE     = 2.0;
const FLIP_CONFIRM_H    = 3;     // hours of consecutive signal before flip
const MAKER_FEE         = 0.0002;
const TAKER_FEE         = 0.0010;
const BLENDED_FEE       = MAKER_FEE * 0.7 + TAKER_FEE * 0.3;
const ROUND_TRIP_FEE    = BLENDED_FEE * 2;
const REBALANCE_H       = 8;
const DELTA_DRIFT_PCT   = 0.02;  // 2% position drift per rebalance period
const USDC_APY          = 0.03;
const INITIAL_CAPITAL   = 10_000;

interface HourlyBar {
  ts: number;
  asset: string;
  hourlyRate: number;
  apy: number;
  direction: "short" | "long";
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchBulkRates(asset: string): Promise<HourlyBar[]> {
  const symbol = `${asset}-PERP`;
  const url = `${BASE_URL}/market/${symbol}/fundingRates?limit=750`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn(`${asset}: HTTP ${resp.status}`);
      return [];
    }
    const body: any = await resp.json();
    const records: any[] = body.records ?? [];
    return records
      .filter(r => r.ts && r.fundingRate && r.oraclePriceTwap)
      .map(r => {
        const fr = parseFloat(r.fundingRate);
        const oracle = parseFloat(r.oraclePriceTwap) || 1;
        const hourlyRate = fr / oracle;
        const apy = Math.abs(hourlyRate) * 24 * 365.25;
        const hourBucket = Math.round(r.ts / 3600) * 3600;
        return {
          ts: hourBucket,
          asset,
          hourlyRate,
          apy,
          direction: hourlyRate >= 0 ? "short" : "long",
        } as HourlyBar;
      });
  } catch (err: any) {
    logger.warn(`${asset}: fetch failed — ${err.message}`);
    return [];
  }
}

async function main() {
  logger.info("Backtest v3 starting (bulk endpoint, all assets)");

  // Fetch all assets with 2s delays to avoid rate limits
  const ratesByAsset: Record<string, Map<number, HourlyBar>> = {};
  for (const asset of ASSETS) {
    const bars = await fetchBulkRates(asset);
    const map = new Map<number, HourlyBar>();
    for (const b of bars) map.set(b.ts, b);
    ratesByAsset[asset] = map;
    logger.info(`${asset}: ${bars.length} hourly bars`, {
      avgAPY: bars.length
        ? (bars.reduce((s, b) => s + b.apy, 0) / bars.length * 100).toFixed(1) + "%"
        : "n/a",
    });
    await sleep(2000);
  }

  // Determine simulation window from available data
  const allTs = new Set<number>();
  for (const map of Object.values(ratesByAsset)) {
    for (const ts of map.keys()) allTs.add(ts);
  }
  const sortedTs = [...allTs].sort((a, b) => a - b);
  const startTs  = sortedTs[0];
  const endTs    = sortedTs[sortedTs.length - 1];

  const startDate = new Date(startTs * 1000).toISOString().split("T")[0];
  const endDate   = new Date(endTs * 1000).toISOString().split("T")[0];
  const totalDays = (endTs - startTs) / 86400;

  logger.info(`Simulation window: ${startDate} → ${endDate} (${totalDays.toFixed(0)} days)`);

  // Per-asset flip protection state
  const flipState: Record<string, { dir: "short" | "long"; oppositeCount: number }> = {};
  for (const asset of ASSETS) flipState[asset] = { dir: "short", oppositeCount: 0 };

  let equity          = INITIAL_CAPITAL;
  let peakEquity      = equity;
  let maxDrawdown     = 0;
  let totalFunding    = 0;
  let totalCosts      = 0;
  let totalPeriods    = 0;
  let fundingPeriods  = 0;
  let directionFlips  = 0;
  let deployedPeriods = 0;

  const dailyEquity: { date: string; equity: number }[] = [];
  let prevDayDate = "";

  // Per-asset stats
  const assetStats: Record<string, { income: number; periods: number; avgAPY: number }> = {};
  for (const asset of ASSETS) assetStats[asset] = { income: 0, periods: 0, avgAPY: 0 };

  for (const ts of sortedTs) {
    // Gather candidates this hour
    const candidates: HourlyBar[] = [];
    for (const asset of ASSETS) {
      const bar = ratesByAsset[asset].get(ts);
      if (bar && bar.apy >= MIN_FUNDING_APY) candidates.push(bar);
    }
    candidates.sort((a, b) => b.apy - a.apy);
    const selected = candidates.slice(0, TOP_N_ASSETS);

    let periodFunding = 0;
    let periodCosts   = 0;

    for (const bar of selected) {
      const state = flipState[bar.asset];
      const newDir = bar.direction;

      // Flip protection
      if (newDir !== state.dir) {
        state.oppositeCount++;
        if (state.oppositeCount >= FLIP_CONFIRM_H) {
          state.dir = newDir;
          state.oppositeCount = 0;
          directionFlips++;
          // Round-trip cost to reverse position
          const perpSize = (equity / TOP_N_ASSETS) * PERP_LEVERAGE;
          periodCosts += perpSize * ROUND_TRIP_FEE;
        }
      } else {
        state.oppositeCount = 0;
      }

      const capitalPerAsset = equity / TOP_N_ASSETS;
      const perpSize         = capitalPerAsset * PERP_LEVERAGE;
      const funding          = perpSize * Math.abs(bar.hourlyRate);

      periodFunding += funding;
      assetStats[bar.asset].income += funding;
      assetStats[bar.asset].periods++;
      assetStats[bar.asset].avgAPY += bar.apy;
      deployedPeriods++;
    }

    // Idle capital earns USDC deposit APY
    const idleFraction = Math.max(0, 1 - selected.length / TOP_N_ASSETS);
    const idleYield = equity * idleFraction * (USDC_APY / (24 * 365.25));
    periodFunding += idleYield;

    // Rebalance cost every 8h
    if (ts % (REBALANCE_H * 3600) === 0 && selected.length > 0) {
      const perpExposure = equity * PERP_LEVERAGE * (selected.length / TOP_N_ASSETS);
      periodCosts += perpExposure * DELTA_DRIFT_PCT * BLENDED_FEE;
    }

    totalFunding += periodFunding;
    totalCosts   += periodCosts;
    equity        = equity + periodFunding - periodCosts;

    if (periodFunding - periodCosts > 0) fundingPeriods++;
    totalPeriods++;

    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;

    const date = new Date(ts * 1000).toISOString().split("T")[0];
    if (date !== prevDayDate) {
      dailyEquity.push({ date, equity });
      prevDayDate = date;
    }
  }

  const totalReturn    = (equity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const annualized     = totalReturn * (365.25 / totalDays);
  const avgDailyRet    = dailyEquity.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    return s + (d.equity - arr[i-1].equity) / arr[i-1].equity;
  }, 0) / (dailyEquity.length - 1);
  const variance       = dailyEquity.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i-1].equity) / arr[i-1].equity;
    return s + Math.pow(r - avgDailyRet, 2);
  }, 0) / (dailyEquity.length - 1);
  const sharpe         = Math.sqrt(365.25) * avgDailyRet / Math.sqrt(variance);

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║   BACKTEST v3 — REAL DATA, ALL ASSETS, 2x LEVERAGE   ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\nPeriod:          ${startDate} → ${endDate} (${totalDays.toFixed(0)} days)`);
  console.log(`Strategy:        Top-${TOP_N_ASSETS} assets by funding APY, ${PERP_LEVERAGE}x leverage`);
  console.log(`Flip protection: ${FLIP_CONFIRM_H} consecutive hours before direction reversal`);
  console.log(`Min APY filter:  ${MIN_FUNDING_APY * 100}%`);

  console.log("\n─── PERFORMANCE ─────────────────────────────────────────");
  console.log(`Total Return:         ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`);
  console.log(`Final Equity:         $${equity.toFixed(2)}`);
  console.log(`Annualized Return:    ${annualized >= 0 ? "+" : ""}${annualized.toFixed(2)}%`);
  console.log(`Max Drawdown:         ${maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio:         ${sharpe.toFixed(2)}`);
  console.log(`Gross Funding:        $${totalFunding.toFixed(2)}`);
  console.log(`Total Costs:          $${totalCosts.toFixed(2)}`);
  console.log(`Net P&L:              $${(equity - INITIAL_CAPITAL).toFixed(2)}`);
  console.log(`Direction Flips:      ${directionFlips}`);
  console.log(`Win Rate (hourly):    ${(fundingPeriods / totalPeriods * 100).toFixed(1)}%`);
  console.log(`Deployment Rate:      ${(deployedPeriods / totalPeriods * 100).toFixed(1)}% of hours active`);

  console.log("\n─── PER-ASSET CONTRIBUTION ──────────────────────────────");
  for (const asset of ASSETS) {
    const s = assetStats[asset];
    if (s.periods === 0) continue;
    const avgAPY = s.avgAPY / s.periods * 100;
    console.log(`  ${asset.padEnd(6)} | $${s.income.toFixed(2).padStart(8)} income | ${s.periods} hours active | avg ${avgAPY.toFixed(1)}% APY`);
  }

  console.log("\n─── DAILY EQUITY CURVE ──────────────────────────────────");
  for (const d of dailyEquity) {
    const pct = ((d.equity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(2);
    const sign = parseFloat(pct) >= 0 ? "+" : "";
    const bar = "#".repeat(Math.max(0, Math.round(parseFloat(pct))));
    console.log(`${d.date}  $${d.equity.toFixed(2).padStart(10)}  ${sign}${pct}%  ${bar}`);
  }

  const output = {
    version: "v3",
    dataSource: "Drift Data API bulk endpoint (real on-chain data)",
    period: { start: startDate, end: endDate, days: totalDays.toFixed(0) },
    parameters: {
      assets: ASSETS, topN: TOP_N_ASSETS,
      minFundingAPY: `${MIN_FUNDING_APY * 100}%`,
      leverage: `${PERP_LEVERAGE}x`,
      flipConfirmHours: FLIP_CONFIRM_H,
    },
    performance: {
      initialCapital: `$${INITIAL_CAPITAL}`,
      finalEquity: `$${equity.toFixed(2)}`,
      totalReturn: `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
      annualizedReturn: `${annualized >= 0 ? "+" : ""}${annualized.toFixed(2)}%`,
      maxDrawdown: `${maxDrawdown.toFixed(2)}%`,
      sharpeRatio: sharpe.toFixed(2),
      grossFunding: `$${totalFunding.toFixed(2)}`,
      totalCosts: `$${totalCosts.toFixed(2)}`,
      netPnL: `$${(equity - INITIAL_CAPITAL).toFixed(2)}`,
      directionFlips,
      winRate: `${(fundingPeriods / totalPeriods * 100).toFixed(1)}%`,
      deploymentRate: `${(deployedPeriods / totalPeriods * 100).toFixed(1)}%`,
    },
    assetContributions: Object.fromEntries(
      ASSETS.filter(a => assetStats[a].periods > 0).map(a => [a, {
        income: `$${assetStats[a].income.toFixed(2)}`,
        hoursActive: assetStats[a].periods,
        avgFundingAPY: `${(assetStats[a].avgAPY / assetStats[a].periods * 100).toFixed(1)}%`,
      }])
    ),
    equityCurve: dailyEquity.map(d => ({
      date: d.date,
      equity: d.equity.toFixed(2),
      returnPct: `${((d.equity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(2)}%`,
    })),
  };

  const filename = `backtest_v3_results_${startDate}_${endDate}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${filename}`);
}

main().catch(console.error);
