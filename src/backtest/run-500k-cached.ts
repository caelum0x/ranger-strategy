/**
 * $500K Scale Backtest — Uses only cached data (no API calls).
 *
 * Runs the same $500K simulation but only with assets that have cached data.
 * This avoids Drift Data API rate limits.
 *
 * Run: npm run backtest:500k-cached
 */
import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = path.join(process.cwd(), ".cache", "funding-rates");

interface HourlyBar {
  ts: number;
  asset: string;
  hourlyRate: number;
  apy: number;
  direction: "short" | "long";
}

interface AssetTier {
  asset: string;
  tier: 1 | 2;
  maxEquityPct: number;
  baseSlippage: number;
  marketImpactCoeff: number;
  maxOrderSizeUsd: number;
}

function loadCachedData(asset: string): Map<number, HourlyBar> {
  const map = new Map<number, HourlyBar>();
  const dir = path.join(CACHE_DIR, asset);
  if (!fs.existsSync(dir)) return map;

  const files = fs.readdirSync(dir).sort();
  for (const file of files) {
    try {
      const bars: HourlyBar[] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      for (const b of bars) map.set(b.ts, b);
    } catch {}
  }
  return map;
}

function calculateSlippage(def: AssetTier, orderSizeUsd: number): number {
  return def.baseSlippage + def.marketImpactCoeff * Math.sqrt(orderSizeUsd / 1_000_000);
}

// Capital ramp
const RAMP_TIERS = [
  { day: 0, fraction: 0.10 },
  { day: 1, fraction: 0.25 },
  { day: 3, fraction: 0.50 },
  { day: 5, fraction: 0.75 },
  { day: 7, fraction: 1.00 },
];

function getRampFraction(daysSinceStart: number): number {
  let f = RAMP_TIERS[0].fraction;
  for (const t of RAMP_TIERS) {
    if (daysSinceStart >= t.day) f = t.fraction;
    else break;
  }
  return f;
}

async function main() {
  // Load whatever we have cached
  const assets: AssetTier[] = [];
  const ratesMap: Record<string, Map<number, HourlyBar>> = {};

  const assetDefs: AssetTier[] = [
    { asset: "SOL", tier: 1, maxEquityPct: 0.35, baseSlippage: 0.0005, marketImpactCoeff: 0.0002, maxOrderSizeUsd: 500_000 },
    { asset: "BTC", tier: 1, maxEquityPct: 0.30, baseSlippage: 0.0005, marketImpactCoeff: 0.0001, maxOrderSizeUsd: 500_000 },
    { asset: "ETH", tier: 1, maxEquityPct: 0.20, baseSlippage: 0.0005, marketImpactCoeff: 0.0002, maxOrderSizeUsd: 500_000 },
    { asset: "JTO", tier: 2, maxEquityPct: 0.08, baseSlippage: 0.0025, marketImpactCoeff: 0.0015, maxOrderSizeUsd: 150_000 },
    { asset: "INJ", tier: 2, maxEquityPct: 0.07, baseSlippage: 0.0020, marketImpactCoeff: 0.0012, maxOrderSizeUsd: 200_000 },
  ];

  for (const def of assetDefs) {
    const data = loadCachedData(def.asset);
    if (data.size > 0) {
      assets.push(def);
      ratesMap[def.asset] = data;
      console.error(`${def.asset}: ${data.size} hourly bars loaded from cache`);
    } else {
      console.error(`${def.asset}: no cached data — skipping`);
    }
  }

  if (assets.length === 0) {
    console.error("No cached data found. Run npm run backtest:realistic first to populate cache.");
    process.exit(1);
  }

  // Normalize weights for available assets
  const totalWeight = assets.reduce((s, a) => s + a.maxEquityPct, 0);
  for (const a of assets) {
    a.maxEquityPct = a.maxEquityPct / totalWeight;
  }

  // Find date range from cached data
  let minTs = Infinity, maxTs = 0;
  for (const [, data] of Object.entries(ratesMap)) {
    for (const [ts] of data) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  }

  const INITIAL_CAPITAL = 500_000;
  const LEVERAGE = 2.0;
  const ENTRY_APY = 0.07;
  const FLIP_ENTRY_APY = 0.15;
  const CLOSE_NEGATIVE_H = 72;
  const FLIP_CONFIRM_H = 48;
  const FLIP_COOLDOWN_H = 48;
  const MAKER_FEE = 0.0002;
  const TAKER_FEE = 0.0010;
  const BLENDED_FEE = MAKER_FEE * 0.7 + TAKER_FEE * 0.3;
  const ROUND_TRIP_FEE = BLENDED_FEE * 2;
  const USDC_APY = 0.04;
  const RISK_FREE_RATE = 0.045;

  const totalDays = (maxTs - minTs) / 86400;

  console.error(`\nPeriod: ${new Date(minTs * 1000).toISOString().split("T")[0]} → ${new Date(maxTs * 1000).toISOString().split("T")[0]} (${totalDays.toFixed(0)} days)`);
  console.error(`Assets: ${assets.map(a => `${a.asset} ${(a.maxEquityPct * 100).toFixed(0)}%`).join(", ")}`);

  // ── Simulation ──
  interface PosState {
    dir: "short" | "long";
    inPosition: boolean;
    flipCount: number;
    negCount: number;
    flipCooldown: number;
  }
  const posState: Record<string, PosState> = {};
  for (const def of assets) {
    posState[def.asset] = { dir: "short", inPosition: false, flipCount: 0, negCount: 0, flipCooldown: 0 };
  }

  let equity = INITIAL_CAPITAL;
  let peakEq = equity;
  let maxDD = 0;
  let totalFund = 0;
  let totalCost = 0;
  let totalImpact = 0;
  let totalHrs = 0;
  let fundHrs = 0;
  let flipCount = 0;

  const dailyRows: { date: string; equity: number }[] = [];
  let prevDate = "";
  const yearlyData: Record<string, { start: number; end: number; funding: number; costs: number }> = {};

  for (let ts = minTs; ts <= maxTs; ts += 3600) {
    const hourBucket = Math.round(ts / 3600) * 3600;
    const daysSinceStart = (ts - minTs) / 86400;
    const rampFraction = getRampFraction(daysSinceStart);

    let periodFunding = 0;
    let periodCost = 0;
    let periodImpact = 0;

    for (const def of assets) {
      const bar = ratesMap[def.asset]?.get(hourBucket);
      const state = posState[def.asset];
      const posSize = equity * def.maxEquityPct * LEVERAGE * rampFraction;

      if (state.flipCooldown > 0) state.flipCooldown--;

      if (!state.inPosition) {
        if (bar && bar.apy >= ENTRY_APY) {
          const actualSize = Math.min(posSize, def.maxOrderSizeUsd);
          const slippage = calculateSlippage(def, actualSize);
          periodCost += actualSize * (ROUND_TRIP_FEE / 2);
          periodImpact += actualSize * slippage;
          state.inPosition = true;
          state.dir = bar.direction;
          state.flipCount = 0;
          state.negCount = 0;
          periodFunding += actualSize * Math.abs(bar.hourlyRate);
        }
        continue;
      }

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

      if (hourlyPnl > 0) state.negCount = 0;
      else state.negCount++;

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

    // Idle yield
    const deployed = assets.filter(d => posState[d.asset].inPosition).reduce((s, d) => s + d.maxEquityPct, 0) * rampFraction;
    periodFunding += equity * Math.max(0, 1 - deployed) * (USDC_APY / (24 * 365.25));

    if (ts % (8 * 3600) === 0) {
      const perpExp = assets.filter(d => posState[d.asset].inPosition)
        .reduce((s, d) => s + equity * d.maxEquityPct * LEVERAGE * rampFraction, 0);
      periodCost += perpExp * 0.005 * BLENDED_FEE;
    }

    totalFund += periodFunding;
    totalCost += periodCost;
    totalImpact += periodImpact;
    equity = equity + periodFunding - periodCost - periodImpact;
    totalHrs++;
    if (periodFunding - periodCost - periodImpact > 0) fundHrs++;

    if (equity > peakEq) peakEq = equity;
    const dd = (peakEq - equity) / peakEq * 100;
    if (dd > maxDD) maxDD = dd;

    const date = new Date(ts * 1000).toISOString().split("T")[0];
    if (date !== prevDate) {
      dailyRows.push({ date, equity });
      prevDate = date;
    }

    const yr = date.slice(0, 4);
    if (!yearlyData[yr]) yearlyData[yr] = { start: equity, end: equity, funding: 0, costs: 0 };
    yearlyData[yr].end = equity;
    yearlyData[yr].funding += periodFunding;
    yearlyData[yr].costs += periodCost + periodImpact;
  }

  // Stats
  const totalReturn = (equity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const years = totalDays / 365.25;
  const cagr = (Math.pow(equity / INITIAL_CAPITAL, 1 / years) - 1) * 100;

  const avgDailyRet = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    return s + (d.equity - arr[i - 1].equity) / arr[i - 1].equity;
  }, 0) / (dailyRows.length - 1 || 1);

  const variance = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i - 1].equity) / arr[i - 1].equity;
    return s + Math.pow(r - avgDailyRet, 2);
  }, 0) / (dailyRows.length - 1 || 1);

  const dailyRfRate = RISK_FREE_RATE / 365.25;
  const sharpe = Math.sqrt(365.25) * (avgDailyRet - dailyRfRate) / Math.sqrt(variance || 1e-10);

  const downsideVar = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i - 1].equity) / arr[i - 1].equity - dailyRfRate;
    return s + (r < 0 ? Math.pow(r, 2) : 0);
  }, 0) / (dailyRows.length - 1 || 1);
  const sortino = Math.sqrt(365.25) * (avgDailyRet - dailyRfRate) / Math.sqrt(downsideVar || 1e-10);
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  // Output
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   $500K SCALE BACKTEST (CACHED DATA) — REAL DRIFT FUNDING RATES  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`\nPeriod:          ${new Date(minTs * 1000).toISOString().split("T")[0]} → ${new Date(maxTs * 1000).toISOString().split("T")[0]} (${totalDays.toFixed(0)} days)`);
  console.log(`Initial Capital: $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`Assets:          ${assets.map(a => `${a.asset} ${(a.maxEquityPct * 100).toFixed(0)}%`).join(", ")}`);
  console.log(`Leverage:        ${LEVERAGE}x`);
  console.log(`Capital Ramp:    10% → 100% over 7 days`);
  console.log(`Market Impact:   √(size/$1M) model`);

  console.log("\n─── PERFORMANCE ──────────────────────────────────────────────────");
  console.log(`Total Return:        ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`);
  console.log(`Final Equity:        $${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`CAGR:                ${cagr >= 0 ? "+" : ""}${cagr.toFixed(2)}%`);
  console.log(`Max Drawdown:        ${maxDD.toFixed(2)}%`);
  console.log(`Sharpe Ratio:        ${sharpe.toFixed(2)}`);
  console.log(`Sortino Ratio:       ${sortino.toFixed(2)}`);
  console.log(`Calmar Ratio:        ${calmar.toFixed(2)}`);

  console.log("\n─── COSTS ────────────────────────────────────────────────────────");
  console.log(`Gross Funding:       $${totalFund.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Trading Fees:        $${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Market Impact:       $${totalImpact.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Net P&L:             $${(equity - INITIAL_CAPITAL).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`Cost/Income:         ${((totalCost + totalImpact) / totalFund * 100).toFixed(1)}%`);
  console.log(`Direction Flips:     ${flipCount}`);
  console.log(`Win Rate:            ${(fundHrs / totalHrs * 100).toFixed(1)}%`);

  console.log("\n─── YEARLY ───────────────────────────────────────────────────────");
  let ys = INITIAL_CAPITAL;
  for (const [yr, v] of Object.entries(yearlyData).sort()) {
    const ret = ((v.end - ys) / ys * 100).toFixed(2);
    console.log(`${yr}: $${ys.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)} → $${v.end.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(9)}  ${parseFloat(ret) >= 0 ? "+" : ""}${ret}%`);
    ys = v.end;
  }

  console.log("\n─── COMPARISON ───────────────────────────────────────────────────");
  console.log(`$10K ideal:     +45.76% CAGR, 0.32% max DD, Sharpe 9.58`);
  console.log(`$10K realistic: +44.88% CAGR, 0.60% max DD, Sharpe 9.37`);
  console.log(`$500K (this):   +${cagr.toFixed(2)}% CAGR, ${maxDD.toFixed(2)}% max DD, Sharpe ${sharpe.toFixed(2)}`);

  // Meets 10% APY requirement?
  console.log(`\n${cagr > 10 ? "✓" : "✗"} Meets 10% APY minimum requirement: ${cagr.toFixed(2)}% CAGR`);

  // Save
  const output = {
    version: "500k-cached-v1",
    dataSource: "Drift Data API — cached on-chain funding rates",
    initialCapital: INITIAL_CAPITAL,
    period: {
      start: new Date(minTs * 1000).toISOString().split("T")[0],
      end: new Date(maxTs * 1000).toISOString().split("T")[0],
      days: totalDays.toFixed(0),
    },
    assets: assets.map(a => ({ asset: a.asset, weight: `${(a.maxEquityPct * 100).toFixed(0)}%`, tier: a.tier })),
    performance: {
      totalReturn: `${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
      finalEquity: `$${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      cagr: `+${cagr.toFixed(2)}%`,
      maxDrawdown: `${maxDD.toFixed(2)}%`,
      sharpe: sharpe.toFixed(2),
      sortino: sortino.toFixed(2),
      calmar: calmar.toFixed(2),
      costIncome: `${((totalCost + totalImpact) / totalFund * 100).toFixed(1)}%`,
      flips: flipCount,
      winRate: `${(fundHrs / totalHrs * 100).toFixed(1)}%`,
    },
    equityCurve: dailyRows.map(d => ({ date: d.date, equity: d.equity.toFixed(2) })),
  };

  fs.writeFileSync("backtest_500k_cached.json", JSON.stringify(output, null, 2));
  console.log("\nSaved to backtest_500k_cached.json");
}

main().catch(console.error);
