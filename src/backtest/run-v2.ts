/**
 * Backtest v2 — Improved delta-neutral funding harvester
 *
 * Changes from v1:
 *  - Expanded asset universe (7 assets incl. JTO, JUP, PYTH, WIF)
 *  - Dynamic top-N selection per period (concentrate on highest-yield)
 *  - Flip protection: require 3 consecutive opposite signals before reversing
 *  - Realistic rebalance cost: 0.088% * delta_pct (not 0.02% on full equity per 8h)
 *  - Optional perp leverage (default 2x — doubles funding income and risk)
 *  - Idle capital earns USDC deposit rate
 *
 * Data: Drift Data API (https://data.api.drift.trade) — real on-chain history
 */
import Decimal from "decimal.js";
import * as fs from "fs";
import { DriftDataAPI, FundingRateEntry, BorrowRateEntry } from "../drift/data-api";
import { logger } from "../utils/logger";

const ASSETS = ["SOL", "BTC", "ETH", "JTO", "JUP", "PYTH", "WIF"];

const START_DATE = new Date("2025-09-01");
const END_DATE   = new Date("2026-03-09");
const INITIAL_CAPITAL = new Decimal(10_000);

// Strategy parameters
const TOP_N_ASSETS      = 2;          // deploy to top-N by funding APY
const MIN_FUNDING_APY   = 0.10;       // 10% APY minimum to deploy (annualized fraction, not %)
const PERP_LEVERAGE     = 2.0;        // leverage on the short/long perp leg
const FLIP_CONFIRM_PERIODS = 3;       // consecutive opposite signals before direction flip
const MAKER_FEE         = 0.0002;     // 0.02% maker
const TAKER_FEE         = 0.0010;     // 0.10% taker
const BLENDED_FEE       = MAKER_FEE * 0.7 + TAKER_FEE * 0.3; // 0.044%
const ROUND_TRIP_FEE    = BLENDED_FEE * 2;                    // 0.088%
// Delta rebalance: assume 2% position drift per 8h period, rebalance only the drift
const DELTA_DRIFT_PCT   = 0.02;       // 2% position drift before rebalance
const REBALANCE_INTERVAL_H = 8;       // rebalance every 8h
// USDC deposit rate (idle capital yield) — real Drift deposit rate ~3% APY
const USDC_DEPOSIT_APY  = 0.03;
const USDC_HOURLY_RATE  = USDC_DEPOSIT_APY / (24 * 365.25);

interface HourlyRate {
  ts: number;
  hourlyRate: number; // fraction, e.g. 0.0001 = 0.01% per hour
  annualizedAPY: number; // fraction, e.g. 0.30 = 30%
  direction: "short" | "long"; // perp direction that collects
}

async function fetchRatesForAsset(
  api: DriftDataAPI,
  asset: string
): Promise<Map<number, HourlyRate>> {
  const symbol = `${asset}-PERP`;
  const map = new Map<number, HourlyRate>();

  const current = new Date(START_DATE);
  while (current <= END_DATE) {
    try {
      const entries: FundingRateEntry[] = await api.getFundingRatesByDate(
        symbol,
        current.getFullYear(),
        current.getMonth() + 1,
        current.getDate()
      );
      for (const e of entries) {
        if (!e.ts || !e.fundingRate) continue;
        const oracle = e.oraclePriceTwap !== 0 ? e.oraclePriceTwap : 1;
        const hourlyRate = e.fundingRate / oracle;
        const annualizedAPY = Math.abs(hourlyRate) * 24 * 365.25;
        // Snap to nearest hour bucket
        const hourBucket = Math.round(e.ts / 3600) * 3600;
        if (!map.has(hourBucket)) {
          map.set(hourBucket, {
            ts: hourBucket,
            hourlyRate,
            annualizedAPY,
            direction: hourlyRate >= 0 ? "short" : "long",
          });
        }
      }
    } catch {
      // Day missing — skip
    }
    current.setDate(current.getDate() + 1);
  }
  return map;
}

async function fetchUsdcDepositRates(api: DriftDataAPI): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const rates: BorrowRateEntry[] = await api.getDepositRateHistory("USDC", 500);
    for (const r of rates) {
      const hourBucket = Math.round(r.ts / 3600) * 3600;
      map.set(hourBucket, r.rate / (24 * 365.25)); // annualized → hourly
    }
  } catch { /* fallback to constant */ }
  return map;
}

function closestRate(map: Map<number, number>, ts: number, windowH = 24): number {
  for (let delta = 0; delta <= windowH * 3600; delta += 3600) {
    if (map.has(ts - delta)) return map.get(ts - delta)!;
    if (map.has(ts + delta)) return map.get(ts + delta)!;
  }
  return USDC_HOURLY_RATE; // fallback
}

async function main() {
  const api = new DriftDataAPI();

  logger.info("Backtest v2 starting", {
    assets: ASSETS,
    topN: TOP_N_ASSETS,
    minFundingAPY: `${MIN_FUNDING_APY * 100}%`,
    leverage: `${PERP_LEVERAGE}x`,
    flipConfirm: FLIP_CONFIRM_PERIODS,
    period: `${START_DATE.toISOString().split("T")[0]} → ${END_DATE.toISOString().split("T")[0]}`,
  });

  // Fetch all rates
  const assetRates: Record<string, Map<number, HourlyRate>> = {};
  for (const asset of ASSETS) {
    assetRates[asset] = await fetchRatesForAsset(api, asset);
    logger.info(`${asset}: ${assetRates[asset].size} hourly rate buckets`);
  }
  const usdcRates = await fetchUsdcDepositRates(api);
  logger.info(`USDC deposit rate entries: ${usdcRates.size}`);

  // Simulation state
  let equity          = INITIAL_CAPITAL;
  let peakEquity      = equity;
  let maxDrawdown     = new Decimal(0);
  let totalFunding    = new Decimal(0);
  let totalLending    = new Decimal(0); // USDC idle yield
  let totalCosts      = new Decimal(0);
  let totalPeriods    = 0;
  let fundingPeriods  = 0;
  let directionFlips  = 0;
  let capitalDeployed = 0; // count of periods capital was in a trade

  // Per-asset direction flip protection
  const assetState: Record<string, {
    currentDir: "short" | "long";
    oppositeCount: number;
  }> = {};
  for (const asset of ASSETS) {
    assetState[asset] = { currentDir: "short", oppositeCount: 0 };
  }

  const dailyReturns: { date: string; equity: number; return: number }[] = [];
  let prevDayEquity = equity.toNumber();
  let prevDayDate   = "";

  const startTs = START_DATE.getTime() / 1000;
  const endTs   = END_DATE.getTime() / 1000;

  for (let ts = startTs; ts < endTs; ts += 3600) {
    const hourBucket = Math.round(ts / 3600) * 3600;

    // Collect available funding rates this hour
    const available: { asset: string; rate: HourlyRate }[] = [];
    for (const asset of ASSETS) {
      // Look within ±1h window
      let rate: HourlyRate | undefined;
      for (let d = 0; d <= 3600; d += 3600) {
        rate = assetRates[asset].get(hourBucket - d) ?? assetRates[asset].get(hourBucket + d);
        if (rate) break;
      }
      if (rate && rate.annualizedAPY >= MIN_FUNDING_APY) {
        available.push({ asset, rate });
      }
    }

    // Sort by APY descending, take top N
    available.sort((a, b) => b.rate.annualizedAPY - a.rate.annualizedAPY);
    const selected = available.slice(0, TOP_N_ASSETS);

    let periodFunding  = new Decimal(0);
    let periodCosts    = new Decimal(0);
    const deployedAssets = selected.length;

    for (const { asset, rate } of selected) {
      const state = assetState[asset];
      const newDir = rate.direction;

      // Direction flip protection: require FLIP_CONFIRM_PERIODS consecutive signals
      let actualDir = state.currentDir;
      if (newDir !== state.currentDir) {
        state.oppositeCount++;
        if (state.oppositeCount >= FLIP_CONFIRM_PERIODS) {
          // Execute flip
          actualDir = newDir;
          state.currentDir = newDir;
          state.oppositeCount = 0;
          directionFlips++;

          // Flip cost: close + re-open (2 round-trips on leveraged position)
          const positionSize = equity.div(TOP_N_ASSETS).mul(PERP_LEVERAGE);
          const flipCost = positionSize.mul(ROUND_TRIP_FEE);
          periodCosts = periodCosts.add(flipCost);
        }
      } else {
        state.oppositeCount = 0;
      }

      // Position size per asset (leveraged perp, 1x spot hedge)
      const capitalPerAsset = equity.div(TOP_N_ASSETS);
      const perpSize         = capitalPerAsset.mul(PERP_LEVERAGE);

      // Funding income: |rate| per hour × position size (leverage amplifies)
      const hourlyFunding = perpSize.mul(Math.abs(rate.hourlyRate));
      periodFunding = periodFunding.add(hourlyFunding);
      capitalDeployed++;
    }

    // Idle capital (not deployed) earns USDC deposit rate
    const idleFraction = deployedAssets < TOP_N_ASSETS
      ? new Decimal(1 - deployedAssets / TOP_N_ASSETS)
      : new Decimal(0);
    if (idleFraction.gt(0)) {
      const idleYield = equity.mul(idleFraction).mul(
        closestRate(usdcRates, hourBucket)
      );
      totalLending = totalLending.add(idleYield);
      periodFunding = periodFunding.add(idleYield);
    }

    // Periodic delta rebalance cost (every REBALANCE_INTERVAL_H hours)
    if (ts % (REBALANCE_INTERVAL_H * 3600) === 0 && deployedAssets > 0) {
      const perpExposure = equity.mul(PERP_LEVERAGE).mul(deployedAssets / TOP_N_ASSETS);
      const rebalanceCost = perpExposure.mul(DELTA_DRIFT_PCT).mul(BLENDED_FEE);
      periodCosts = periodCosts.add(rebalanceCost);
    }

    totalFunding = totalFunding.add(periodFunding);
    totalCosts   = totalCosts.add(periodCosts);
    equity       = equity.add(periodFunding).sub(periodCosts);

    if (periodFunding.gt(0)) fundingPeriods++;
    totalPeriods++;

    // Drawdown tracking
    if (equity.gt(peakEquity)) peakEquity = equity;
    const dd = peakEquity.sub(equity).div(peakEquity).mul(100);
    if (dd.gt(maxDrawdown)) maxDrawdown = dd;

    // Daily snapshot
    const date = new Date(ts * 1000).toISOString().split("T")[0];
    if (date !== prevDayDate) {
      if (prevDayDate !== "") {
        dailyReturns.push({
          date: prevDayDate,
          equity: equity.toNumber(),
          return: (equity.toNumber() - prevDayEquity) / prevDayEquity,
        });
      }
      prevDayDate   = date;
      prevDayEquity = equity.toNumber();
    }
  }

  // Final daily snapshot
  dailyReturns.push({
    date: prevDayDate,
    equity: equity.toNumber(),
    return: (equity.toNumber() - prevDayEquity) / prevDayEquity,
  });

  // Statistics
  const totalReturn   = equity.sub(INITIAL_CAPITAL).div(INITIAL_CAPITAL);
  const totalDays     = (END_DATE.getTime() - START_DATE.getTime()) / 86400000;
  const annualized    = totalReturn.mul(365.25 / totalDays);

  const avgDailyRet   = dailyReturns.reduce((s, d) => s + d.return, 0) / dailyReturns.length;
  const variance      = dailyReturns.reduce((s, d) => s + Math.pow(d.return - avgDailyRet, 2), 0) / dailyReturns.length;
  const stdDev        = Math.sqrt(variance);
  const sharpe        = stdDev > 0 ? (avgDailyRet / stdDev) * Math.sqrt(365.25) : 0;

  // Monthly breakdown
  const monthly: Record<string, { start: number; end: number }> = {};
  let prev = INITIAL_CAPITAL.toNumber();
  for (const d of dailyReturns) {
    const m = d.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = { start: prev, end: d.equity };
    else monthly[m].end = d.equity;
    prev = d.equity;
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║   BACKTEST v2 — IMPROVED DELTA-NEUTRAL STRATEGY      ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\nPeriod:          ${START_DATE.toDateString()} → ${END_DATE.toDateString()}`);
  console.log(`Assets:          ${ASSETS.join(", ")}`);
  console.log(`Top-N deployed:  ${TOP_N_ASSETS} assets at a time`);
  console.log(`Min funding APY: ${MIN_FUNDING_APY * 100}%`);
  console.log(`Perp leverage:   ${PERP_LEVERAGE}x`);
  console.log(`Flip protection: ${FLIP_CONFIRM_PERIODS} consecutive periods`);

  console.log("\n─── PERFORMANCE ─────────────────────────────────────────");
  console.log(`Total Return:         ${totalReturn.mul(100).toFixed(2)}%  ($${equity.toFixed(2)} final)`);
  console.log(`Annualized Return:    ${annualized.mul(100).toFixed(2)}%`);
  console.log(`Max Drawdown:         ${maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio:         ${sharpe.toFixed(2)}`);
  console.log(`Gross Funding:        $${totalFunding.toFixed(2)}`);
  console.log(`USDC Idle Yield:      $${totalLending.toFixed(2)}`);
  console.log(`Total Trading Costs:  $${totalCosts.toFixed(2)}`);
  console.log(`Net P&L:              $${equity.sub(INITIAL_CAPITAL).toFixed(2)}`);
  console.log(`Direction Flips:      ${directionFlips}`);
  console.log(`Hourly Win Rate:      ${(fundingPeriods / totalPeriods * 100).toFixed(1)}%`);
  console.log(`Capital Deployment:   ${(capitalDeployed / totalPeriods * 100).toFixed(1)}% of periods active`);

  console.log("\n─── MONTHLY BREAKDOWN ───────────────────────────────────");
  console.log("Month       Start          End       Return");
  for (const [m, v] of Object.entries(monthly).sort()) {
    const mret = ((v.end - v.start) / v.start * 100).toFixed(2);
    const sign = parseFloat(mret) >= 0 ? "+" : "";
    console.log(`${m}    $${v.start.toFixed(0).padStart(8)}   $${v.end.toFixed(0).padStart(8)}   ${sign}${mret}%`);
  }

  console.log("\n─── EQUITY CURVE (weekly) ───────────────────────────────");
  for (let i = 0; i < dailyReturns.length; i += 7) {
    const d = dailyReturns[i];
    const pct = ((d.equity - 10000) / 10000 * 100).toFixed(2);
    const bar = "#".repeat(Math.max(0, Math.round(parseFloat(pct) / 2)));
    console.log(`${d.date}  $${d.equity.toFixed(2).padStart(9)}  ${parseFloat(pct) >= 0 ? "+" : ""}${pct}%  ${bar}`);
  }

  // Save JSON
  const output = {
    version: "v2",
    strategy: "Improved Delta-Neutral Funding Harvester",
    parameters: {
      assets: ASSETS, topN: TOP_N_ASSETS,
      minFundingAPY: `${MIN_FUNDING_APY * 100}%`,
      leverage: `${PERP_LEVERAGE}x`,
      flipConfirmPeriods: FLIP_CONFIRM_PERIODS,
    },
    period: { start: START_DATE.toISOString(), end: END_DATE.toISOString() },
    performance: {
      initialCapital: "$10,000",
      finalEquity: `$${equity.toFixed(2)}`,
      totalReturn: `${totalReturn.mul(100).toFixed(2)}%`,
      annualizedReturn: `${annualized.mul(100).toFixed(2)}%`,
      maxDrawdown: `${maxDrawdown.toFixed(2)}%`,
      sharpeRatio: sharpe.toFixed(2),
      grossFunding: `$${totalFunding.toFixed(2)}`,
      usdcIdleYield: `$${totalLending.toFixed(2)}`,
      totalTradingCosts: `$${totalCosts.toFixed(2)}`,
      directionFlips,
      hourlyWinRate: `${(fundingPeriods / totalPeriods * 100).toFixed(1)}%`,
      capitalDeploymentRate: `${(capitalDeployed / totalPeriods * 100).toFixed(1)}%`,
    },
    monthly: Object.fromEntries(
      Object.entries(monthly).map(([m, v]) => [m, {
        startEquity: v.start.toFixed(2),
        endEquity: v.end.toFixed(2),
        return: `${((v.end - v.start) / v.start * 100).toFixed(2)}%`,
      }])
    ),
    equityCurve: dailyReturns.map(d => ({
      date: d.date,
      equity: d.equity.toFixed(2),
      returnPct: (d.return * 100).toFixed(4),
    })),
  };

  const filename = `backtest_v2_results_${START_DATE.toISOString().split("T")[0]}_${END_DATE.toISOString().split("T")[0]}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${filename}`);

  logger.info("Backtest v2 complete", {
    totalReturn: `${totalReturn.mul(100).toFixed(2)}%`,
    annualizedReturn: `${annualized.mul(100).toFixed(2)}%`,
    maxDrawdown: `${maxDrawdown.toFixed(2)}%`,
    sharpe: sharpe.toFixed(2),
    directionFlips,
  });
}

main().catch(console.error);
