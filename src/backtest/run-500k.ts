/**
 * $500K Scale Backtest — Delta-Neutral Funding Harvester
 *
 * Same 3-year real Drift data as the $10K backtest, but models:
 *   - $500K initial capital
 *   - Market impact on Tier 2 assets (JTO/INJ) — orders that move price
 *   - Phased capital ramp (10% → 100% over first 10 days)
 *   - Per-asset liquidity tier constraints
 *   - Higher slippage for larger orders (√size scaling)
 *   - Reduced allocation to thin markets at scale
 *
 * Run: npm run backtest:500k
 */
import * as fs from "fs";
import { fetchAssetRange, HourlyBar } from "./fetch-cache";

// ── Asset universe with $500K-specific constraints ──────────────

interface AssetTier500K {
  asset: string;
  tier: 1 | 2;
  maxEquityPct: number;
  baseSlippage: number;       // base one-way slippage
  marketImpactCoeff: number;  // √(size/$1M) multiplier for additional slippage
  maxOrderSizeUsd: number;    // max single order size before splitting
  startDate?: string;
}

const ASSET_UNIVERSE: AssetTier500K[] = [
  { asset: "SOL", tier: 1, maxEquityPct: 0.25, baseSlippage: 0.0005, marketImpactCoeff: 0.0002, maxOrderSizeUsd: 500_000 },
  { asset: "BTC", tier: 1, maxEquityPct: 0.25, baseSlippage: 0.0005, marketImpactCoeff: 0.0001, maxOrderSizeUsd: 500_000 },
  { asset: "ETH", tier: 1, maxEquityPct: 0.15, baseSlippage: 0.0005, marketImpactCoeff: 0.0002, maxOrderSizeUsd: 500_000 },
  { asset: "JTO", tier: 2, maxEquityPct: 0.18, baseSlippage: 0.0025, marketImpactCoeff: 0.0015, maxOrderSizeUsd: 150_000, startDate: "2023-12-01" },
  { asset: "INJ", tier: 2, maxEquityPct: 0.17, baseSlippage: 0.0020, marketImpactCoeff: 0.0012, maxOrderSizeUsd: 200_000 },
  // total = 1.00
];

// Support 1-year period via BACKTEST_PERIOD=1y
const period = process.env.BACKTEST_PERIOD || "3y";
const START_DATE = period === "1y" ? new Date("2025-03-15") : new Date("2023-03-01");
const END_DATE   = new Date("2026-03-15");
const INITIAL_CAPITAL = 500_000;

const LEVERAGE          = 2.0;
const ENTRY_APY         = 0.07;
const FLIP_ENTRY_APY    = 0.15;
const CLOSE_NEGATIVE_H  = 72;
const FLIP_CONFIRM_H    = 48;
const FLIP_COOLDOWN_H   = 48;
const MAKER_FEE         = 0.0002;
const TAKER_FEE         = 0.0010;
const BLENDED_FEE       = MAKER_FEE * 0.7 + TAKER_FEE * 0.3;
const ROUND_TRIP_FEE    = BLENDED_FEE * 2;
const USDC_APY          = 0.04;
const RISK_FREE_RATE    = 0.045;
const FETCH_DELAY_MS    = 350;

// Capital ramp: fraction of total capital available on each day
const RAMP_TIERS = [
  { day: 0, fraction: 0.10 },   // $50K
  { day: 1, fraction: 0.25 },   // $125K
  { day: 3, fraction: 0.50 },   // $250K
  { day: 5, fraction: 0.75 },   // $375K
  { day: 7, fraction: 1.00 },   // $500K
];

function getRampFraction(daysSinceStart: number): number {
  let fraction = RAMP_TIERS[0].fraction;
  for (const tier of RAMP_TIERS) {
    if (daysSinceStart >= tier.day) fraction = tier.fraction;
    else break;
  }
  return fraction;
}

/**
 * Calculate total slippage for a given order size.
 * Models square-root market impact: larger orders move price more.
 */
function calculateSlippage(def: AssetTier500K, orderSizeUsd: number): number {
  const sqrtImpact = def.marketImpactCoeff * Math.sqrt(orderSizeUsd / 1_000_000);
  return def.baseSlippage + sqrtImpact;
}

async function main() {
  const totalDays = (END_DATE.getTime() - START_DATE.getTime()) / 86400000;
  console.error(`\n$500K Scale Backtest: ${START_DATE.toISOString().split("T")[0]} → ${END_DATE.toISOString().split("T")[0]} (${totalDays.toFixed(0)} days)`);
  console.error(`Initial capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.error(`Market impact model: √(size/$1M) scaling`);
  console.error(`Capital ramp: 10% → 100% over 7 days\n`);

  // Fetch all assets
  const ratesMap: Record<string, Map<number, HourlyBar>> = {};
  for (const def of ASSET_UNIVERSE) {
    const start = def.startDate ? new Date(def.startDate) : START_DATE;
    ratesMap[def.asset] = await fetchAssetRange(def.asset, start, END_DATE, FETCH_DELAY_MS);
  }

  // ── Simulation ──
  interface PosState {
    dir: "short" | "long";
    inPosition: boolean;
    flipCount: number;
    negCount: number;
    flipCooldown: number;
  }
  const posState: Record<string, PosState> = {};
  for (const def of ASSET_UNIVERSE) {
    posState[def.asset] = { dir: "short", inPosition: false, flipCount: 0, negCount: 0, flipCooldown: 0 };
  }

  let equity = INITIAL_CAPITAL;
  let peakEq = equity;
  let maxDD = 0;
  let totalFund = 0;
  let totalCost = 0;
  let totalMarketImpact = 0;
  let totalHrs = 0;
  let fundHrs = 0;
  let flipCount = 0;
  let blockedOrders = 0; // orders blocked by size limits

  const monthly: Record<string, { start: number; end: number; funding: number; costs: number; impact: number }> = {};
  const dailyRows: { date: string; equity: number; rampFraction: number }[] = [];
  let prevDate = "";

  const startTs = START_DATE.getTime() / 1000;
  const endTs = END_DATE.getTime() / 1000;

  for (let ts = startTs; ts < endTs; ts += 3600) {
    const hourBucket = Math.round(ts / 3600) * 3600;
    const daysSinceStart = (ts - startTs) / 86400;
    const rampFraction = getRampFraction(daysSinceStart);

    let periodFunding = 0;
    let periodCost = 0;
    let periodImpact = 0;

    for (const def of ASSET_UNIVERSE) {
      const bar = ratesMap[def.asset]?.get(hourBucket);
      const state = posState[def.asset];

      // Position size with ramp and leverage
      const rawPosSize = equity * def.maxEquityPct * LEVERAGE;
      const posSize = rawPosSize * rampFraction;

      if (state.flipCooldown > 0) state.flipCooldown--;

      // ── NOT IN POSITION ──
      if (!state.inPosition) {
        if (bar && bar.apy >= ENTRY_APY) {
          // Check max order size constraint for thin markets
          if (posSize > def.maxOrderSizeUsd) {
            blockedOrders++;
            // Still open, but cap at max safe size
            const cappedSize = def.maxOrderSizeUsd;
            const slippage = calculateSlippage(def, cappedSize);
            periodCost += cappedSize * (ROUND_TRIP_FEE / 2);
            periodImpact += cappedSize * slippage;
            state.inPosition = true;
            state.dir = bar.direction;
            state.flipCount = 0;
            state.negCount = 0;
            periodFunding += cappedSize * Math.abs(bar.hourlyRate);
          } else {
            const slippage = calculateSlippage(def, posSize);
            periodCost += posSize * (ROUND_TRIP_FEE / 2);
            periodImpact += posSize * slippage;
            state.inPosition = true;
            state.dir = bar.direction;
            state.flipCount = 0;
            state.negCount = 0;
            periodFunding += posSize * Math.abs(bar.hourlyRate);
          }
        }
        continue;
      }

      // ── IN POSITION ──
      if (!bar) {
        state.negCount++;
        if (state.negCount >= CLOSE_NEGATIVE_H) {
          const slippage = calculateSlippage(def, posSize);
          periodCost += posSize * (ROUND_TRIP_FEE / 2);
          periodImpact += posSize * slippage;
          state.inPosition = false;
          state.negCount = 0;
          state.flipCount = 0;
        }
        continue;
      }

      const isCorrectSide = state.dir === bar.direction;
      const hourlyPnl = isCorrectSide
        ? posSize * Math.abs(bar.hourlyRate)
        : -posSize * Math.abs(bar.hourlyRate);

      periodFunding += hourlyPnl;

      if (hourlyPnl > 0) {
        state.negCount = 0;
      } else {
        state.negCount++;
      }

      // Direction flip detection
      if (state.flipCooldown === 0 && bar.direction !== state.dir) {
        state.flipCount++;
        if (state.flipCount >= FLIP_CONFIRM_H) {
          if (bar.apy >= FLIP_ENTRY_APY) {
            const slippage = calculateSlippage(def, posSize);
            periodCost += posSize * ROUND_TRIP_FEE;
            periodImpact += posSize * slippage * 2;
            state.dir = bar.direction;
            state.flipCooldown = FLIP_COOLDOWN_H;
            flipCount++;
          } else {
            const slippage = calculateSlippage(def, posSize);
            periodCost += posSize * (ROUND_TRIP_FEE / 2);
            periodImpact += posSize * slippage;
            state.inPosition = false;
          }
          state.flipCount = 0;
          state.negCount = 0;
        }
      } else if (bar.direction === state.dir) {
        state.flipCount = 0;
      }

      if (state.inPosition && state.negCount >= CLOSE_NEGATIVE_H) {
        const slippage = calculateSlippage(def, posSize);
        periodCost += posSize * (ROUND_TRIP_FEE / 2);
        periodImpact += posSize * slippage;
        state.inPosition = false;
        state.negCount = 0;
        state.flipCount = 0;
      }
    }

    // Idle USDC yield
    const deployedFraction = ASSET_UNIVERSE
      .filter(d => posState[d.asset].inPosition)
      .reduce((s, d) => s + d.maxEquityPct, 0) * rampFraction;
    const idleFraction = Math.max(0, 1 - deployedFraction);
    periodFunding += equity * idleFraction * (USDC_APY / (24 * 365.25));

    // 8h rebalance cost
    if (ts % (8 * 3600) === 0) {
      const perpExposure = ASSET_UNIVERSE
        .filter(d => posState[d.asset].inPosition)
        .reduce((s, d) => s + equity * d.maxEquityPct * LEVERAGE * rampFraction, 0);
      periodCost += perpExposure * 0.005 * BLENDED_FEE;
    }

    totalFund += periodFunding;
    totalCost += periodCost;
    totalMarketImpact += periodImpact;
    equity = equity + periodFunding - periodCost - periodImpact;
    totalHrs++;
    if (periodFunding - periodCost - periodImpact > 0) fundHrs++;

    if (equity > peakEq) peakEq = equity;
    const dd = (peakEq - equity) / peakEq * 100;
    if (dd > maxDD) maxDD = dd;

    const date = new Date(ts * 1000).toISOString().split("T")[0];
    if (date !== prevDate) {
      dailyRows.push({ date, equity, rampFraction });
      prevDate = date;
    }

    const month = date.slice(0, 7);
    if (!monthly[month]) monthly[month] = { start: equity, end: equity, funding: 0, costs: 0, impact: 0 };
    monthly[month].end = equity;
    monthly[month].funding += periodFunding;
    monthly[month].costs += periodCost;
    monthly[month].impact += periodImpact;
  }

  // ── Statistics ──
  const totalReturn = (equity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const cagr = (Math.pow(equity / INITIAL_CAPITAL, 365.25 / totalDays) - 1) * 100;
  const dailyRfRate = RISK_FREE_RATE / 365.25;

  const avgDailyRet = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    return s + (d.equity - arr[i - 1].equity) / arr[i - 1].equity;
  }, 0) / (dailyRows.length - 1 || 1);

  const variance = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i - 1].equity) / arr[i - 1].equity;
    return s + Math.pow(r - avgDailyRet, 2);
  }, 0) / (dailyRows.length - 1 || 1);

  const sharpe = Math.sqrt(365.25) * (avgDailyRet - dailyRfRate) / Math.sqrt(variance || 1e-10);

  const downsideVariance = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i - 1].equity) / arr[i - 1].equity - dailyRfRate;
    return s + (r < 0 ? Math.pow(r, 2) : 0);
  }, 0) / (dailyRows.length - 1 || 1);
  const sortino = Math.sqrt(365.25) * (avgDailyRet - dailyRfRate) / Math.sqrt(downsideVariance || 1e-10);
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  // ── Output ──
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   $500K SCALE BACKTEST — 3 YEAR DELTA-NEUTRAL STRATEGY       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\nPeriod:          ${START_DATE.toISOString().split("T")[0]} → ${END_DATE.toISOString().split("T")[0]} (${totalDays.toFixed(0)} days)`);
  console.log(`Initial Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`Universe:        SOL 25% + BTC 25% + ETH 15% + JTO 18% + INJ 17% (reweighted for scale)`);
  console.log(`Leverage:        ${LEVERAGE}x on perp leg`);
  console.log(`Capital Ramp:    10% → 25% → 50% → 75% → 100% over 7 days`);
  console.log(`Market Impact:   √(size/$1M) model per asset`);

  console.log("\n─── PERFORMANCE ──────────────────────────────────────────────");
  console.log(`Total Return:        ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`);
  console.log(`Final Equity:        $${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`CAGR:                ${cagr >= 0 ? "+" : ""}${cagr.toFixed(2)}%`);
  console.log(`Max Drawdown:        ${maxDD.toFixed(2)}%`);
  console.log(`Sharpe Ratio:        ${sharpe.toFixed(2)}`);
  console.log(`Sortino Ratio:       ${sortino.toFixed(2)}`);
  console.log(`Calmar Ratio:        ${calmar.toFixed(2)}`);

  console.log("\n─── COST BREAKDOWN ───────────────────────────────────────────");
  console.log(`Gross Funding:       $${totalFund.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Trading Fees:        $${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Market Impact:       $${totalMarketImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Total Costs:         $${(totalCost + totalMarketImpact).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Net P&L:             $${(equity - INITIAL_CAPITAL).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Cost/Income Ratio:   ${((totalCost + totalMarketImpact) / totalFund * 100).toFixed(1)}%`);
  console.log(`Impact/Cost Ratio:   ${(totalMarketImpact / (totalCost + totalMarketImpact) * 100).toFixed(1)}% (market impact share of total cost)`);
  console.log(`Blocked Orders:      ${blockedOrders} (exceeded max order size)`);
  console.log(`Direction Flips:     ${flipCount}`);
  console.log(`Win Rate (hourly):   ${(fundHrs / totalHrs * 100).toFixed(1)}%`);

  console.log("\n─── $500K vs $10K COMPARISON ──────────────────────────────────");
  console.log(`$10K  backtest: +45.76% CAGR, 0.32% max DD, Sharpe 9.58, cost/income 0.9%`);
  console.log(`$500K backtest: +${cagr.toFixed(2)}% CAGR, ${maxDD.toFixed(2)}% max DD, Sharpe ${sharpe.toFixed(2)}, cost/income ${((totalCost + totalMarketImpact) / totalFund * 100).toFixed(1)}%`);
  const cagrDelta = cagr - 45.76;
  console.log(`Scaling penalty: ${cagrDelta.toFixed(2)}% CAGR (${(cagrDelta / 45.76 * 100).toFixed(1)}% degradation from market impact)`);

  console.log("\n─── YEARLY SUMMARY ───────────────────────────────────────────");
  const years = Array.from(new Set(Object.keys(monthly).map(mo => mo.slice(0, 4)))).sort();
  let yearStart = INITIAL_CAPITAL;
  for (const yr of years) {
    const yearMonths = Object.entries(monthly).filter(([mo]) => mo.startsWith(yr)).sort();
    if (!yearMonths.length) continue;
    const yearEnd = yearMonths[yearMonths.length - 1][1].end;
    const yearFund = yearMonths.reduce((s, [, v]) => s + v.funding, 0);
    const yearCost = yearMonths.reduce((s, [, v]) => s + v.costs, 0);
    const yearImpact = yearMonths.reduce((s, [, v]) => s + v.impact, 0);
    const ret = ((yearEnd - yearStart) / yearStart * 100).toFixed(2);
    console.log(`${yr}:  $${yearStart.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)} → $${yearEnd.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)}  ${parseFloat(ret) >= 0 ? "+" : ""}${ret}%  (funding $${yearFund.toLocaleString(undefined, { maximumFractionDigits: 0 })}, fees $${yearCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}, impact $${yearImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
    yearStart = yearEnd;
  }

  // Save JSON
  const output = {
    version: "500k-scale-v1",
    dataSource: "Drift Data API — real on-chain funding rates (cached)",
    initialCapital: INITIAL_CAPITAL,
    period: { start: START_DATE.toISOString().split("T")[0], end: END_DATE.toISOString().split("T")[0], days: totalDays.toFixed(0) },
    parameters: {
      universe: ASSET_UNIVERSE.map(d => ({
        asset: d.asset, tier: d.tier, maxEquityPct: `${(d.maxEquityPct * 100).toFixed(0)}%`,
        baseSlippage: `${(d.baseSlippage * 100).toFixed(2)}%`,
        marketImpactCoeff: d.marketImpactCoeff,
        maxOrderSizeUsd: `$${d.maxOrderSizeUsd.toLocaleString()}`,
      })),
      leverage: `${LEVERAGE}x`,
      capitalRamp: RAMP_TIERS.map(t => `Day ${t.day}: ${(t.fraction * 100).toFixed(0)}%`),
      marketImpactModel: "√(orderSize / $1M) × coefficient",
    },
    performance: {
      finalEquity: `$${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      totalReturn: `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
      cagr: `${cagr >= 0 ? "+" : ""}${cagr.toFixed(2)}%`,
      maxDrawdown: `${maxDD.toFixed(2)}%`,
      sharpeRatio: sharpe.toFixed(2),
      sortinoRatio: sortino.toFixed(2),
      calmarRatio: calmar.toFixed(2),
      grossFunding: `$${totalFund.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      tradingFees: `$${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      marketImpact: `$${totalMarketImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      netPnL: `$${(equity - INITIAL_CAPITAL).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      costIncomeRatio: `${((totalCost + totalMarketImpact) / totalFund * 100).toFixed(1)}%`,
      blockedOrders,
      directionFlips: flipCount,
      winRate: `${(fundHrs / totalHrs * 100).toFixed(1)}%`,
    },
    comparison: {
      tenK: { cagr: "+45.76%", maxDD: "0.32%", sharpe: "9.58", costIncome: "0.9%" },
      fiveHundredK: { cagr: `+${cagr.toFixed(2)}%`, maxDD: `${maxDD.toFixed(2)}%`, sharpe: sharpe.toFixed(2), costIncome: `${((totalCost + totalMarketImpact) / totalFund * 100).toFixed(1)}%` },
      scalingPenaltyCagr: `${cagrDelta.toFixed(2)}%`,
    },
    equityCurve: dailyRows.map(d => ({ date: d.date, equity: d.equity.toFixed(2), rampFraction: d.rampFraction })),
  };

  fs.writeFileSync("backtest_500k_3year.json", JSON.stringify(output, null, 2));
  console.log("\nSaved to backtest_500k_3year.json");
}

main().catch(console.error);
