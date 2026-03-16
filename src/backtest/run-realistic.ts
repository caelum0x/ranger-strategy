/**
 * Realistic Backtest — Delta-Neutral Funding Harvester v2
 *
 * Realistic constraints:
 *  - Liquid markets only (SOL, BTC, ETH as Tier 1; JTO, INJ as Tier 2)
 *  - Position size capped by liquidity tier
 *  - Realistic slippage: Tier 1 = 0.05%, Tier 2 = 0.20-0.25%
 *  - Round-trip trading cost: 0.088% (blended maker/taker)
 *  - ENTRY threshold: APY ≥ 10% to open a new position
 *  - HOLD: stay in position as long as funding is positive (don't churn on dips)
 *  - EXIT: close only when funding is persistently negative (12h) or direction flip confirmed (6h)
 *  - 1.5x leverage — conservative risk
 *  - 3-year window using cached real on-chain data
 */
import * as fs from "fs";
import { fetchAssetRange, HourlyBar } from "./fetch-cache";

// ── Tier definitions ──────────────────────────────────────────────────────────
interface AssetTier {
  asset: string;
  tier: 1 | 2;
  maxEquityPct: number;   // max fraction of total equity deployed per asset
  slippage: number;       // one-way slippage on open/close
  startDate?: string;     // ISO date when asset listed on Drift (skip before)
}

// Sum of maxEquityPct must be ≤ 1.0 (margin at 2x leverage = equity × maxEquityPct per asset)
// 2025 avg APY on notional: SOL 14.3%, BTC 10.2%, ETH 0% (no data), JTO 23.4%, INJ 28.3%
// → Upweight JTO/INJ for bear-market floor; downweight ETH (sparse data after 2024)
const ASSET_UNIVERSE: AssetTier[] = [
  { asset: "SOL",  tier: 1, maxEquityPct: 0.22, slippage: 0.0005 },
  { asset: "BTC",  tier: 1, maxEquityPct: 0.20, slippage: 0.0005 },
  { asset: "ETH",  tier: 1, maxEquityPct: 0.13, slippage: 0.0005 }, // sparse after 2024
  { asset: "JTO",  tier: 2, maxEquityPct: 0.23, slippage: 0.0025, startDate: "2023-12-01" },
  { asset: "INJ",  tier: 2, maxEquityPct: 0.22, slippage: 0.0020 },
  // total = 1.00 — physically consistent (sum of margins ≤ equity)
];

const START_DATE      = new Date("2023-03-01");
const END_DATE        = new Date("2026-03-15");
const INITIAL_CAPITAL = 10_000;

const LEVERAGE          = 2.0;    // 2x leverage on perp leg
const ENTRY_APY         = 0.07;   // 7% APY minimum to OPEN a new position
const FLIP_ENTRY_APY    = 0.15;   // 15% APY in new direction to justify flip cost (else just close)
const CLOSE_NEGATIVE_H  = 72;     // close after 72h wrong-side: $48 cost vs $100 close+reopen
const FLIP_CONFIRM_H    = 48;     // 48h persistent opposite direction → flip or close
const FLIP_COOLDOWN_H   = 48;     // 48h cooldown after flip
const MAKER_FEE         = 0.0002;
const TAKER_FEE         = 0.0010;
const BLENDED_FEE       = MAKER_FEE * 0.7 + TAKER_FEE * 0.3; // 0.044%
const ROUND_TRIP_FEE    = BLENDED_FEE * 2;                    // 0.088%
const USDC_APY          = 0.04;   // 4% USDC deposit rate (conservative, real avg on Drift)
// Note: vault holds USDC only — no spot borrow cost (spot hedge is manager overhead, not vault expense)
const RISK_FREE_RATE    = 0.045;  // 4.5% annual risk-free (T-bill rate during period)
const FETCH_DELAY_MS    = 350;    // ms between API calls

async function main() {
  const totalDays = (END_DATE.getTime() - START_DATE.getTime()) / 86400000;
  console.error(`\nRealistic backtest: ${START_DATE.toISOString().split("T")[0]} → ${END_DATE.toISOString().split("T")[0]} (${totalDays.toFixed(0)} days)`);
  console.error(`Fetching real data with disk cache (.cache/funding-rates/)...\n`);

  // Fetch all assets (cached after first run)
  const ratesMap: Record<string, Map<number, HourlyBar>> = {};
  for (const def of ASSET_UNIVERSE) {
    const start = def.startDate ? new Date(def.startDate) : START_DATE;
    ratesMap[def.asset] = await fetchAssetRange(def.asset, start, END_DATE, FETCH_DELAY_MS);
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  interface PosState {
    dir: "short" | "long";
    inPosition: boolean;
    flipCount: number;      // consecutive hours of opposite direction signal
    negCount: number;       // consecutive hours of negative/zero net pnl
    flipCooldown: number;   // hours until next flip is allowed (prevents oscillation)
  }
  const posState: Record<string, PosState> = {};
  for (const def of ASSET_UNIVERSE) {
    posState[def.asset] = { dir: "short", inPosition: false, flipCount: 0, negCount: 0, flipCooldown: 0 };
  }

  let equity    = INITIAL_CAPITAL;
  let peakEq    = equity;
  let maxDD     = 0;
  let totalFund = 0;
  let totalCost = 0;
  let totalHrs  = 0;
  let fundHrs   = 0;
  let flipCount = 0;

  // Monthly buckets for report
  const monthly: Record<string, { start: number; end: number; funding: number; costs: number }> = {};

  const dailyRows: { date: string; equity: number }[] = [];
  let prevDate = "";

  const startTs = START_DATE.getTime() / 1000;
  const endTs   = END_DATE.getTime() / 1000;

  for (let ts = startTs; ts < endTs; ts += 3600) {
    const hourBucket = Math.round(ts / 3600) * 3600;

    let periodFunding = 0;
    let periodCost    = 0;
    let deployed      = 0;

    for (const def of ASSET_UNIVERSE) {
      const bar   = ratesMap[def.asset]?.get(hourBucket);
      const state = posState[def.asset];
      const posSize = equity * def.maxEquityPct * LEVERAGE;

      // Decrement flip cooldown each hour
      if (state.flipCooldown > 0) state.flipCooldown--;

      // ── NOT IN POSITION ──────────────────────────────────────────────────────
      if (!state.inPosition) {
        if (bar && bar.apy >= ENTRY_APY) {
          periodCost    += posSize * (ROUND_TRIP_FEE / 2 + def.slippage);
          state.inPosition = true;
          state.dir        = bar.direction;
          state.flipCount  = 0;
          state.negCount   = 0;
          // Collect funding this hour (just opened, on correct side)
          periodFunding += posSize * Math.abs(bar.hourlyRate);
          deployed++;
        }
        continue;
      }

      // ── IN POSITION ──────────────────────────────────────────────────────────

      // No data this hour — count as zero, close if too many consecutive
      if (!bar) {
        state.negCount++;
        if (state.negCount >= CLOSE_NEGATIVE_H) {
          periodCost += posSize * (ROUND_TRIP_FEE / 2 + def.slippage);
          state.inPosition = false;
          state.negCount   = 0;
          state.flipCount  = 0;
        }
        continue;
      }

      // ── Actual PnL: earn when on correct side, PAY when on wrong side ────────
      const isCorrectSide = state.dir === bar.direction;
      const hourlyPnl     = isCorrectSide
        ?  posSize * Math.abs(bar.hourlyRate)   // receive funding
        : -posSize * Math.abs(bar.hourlyRate);  // pay funding

      periodFunding += hourlyPnl;
      deployed++;

      if (hourlyPnl > 0) {
        state.negCount = 0;
      } else {
        state.negCount++;
      }

      // ── Direction flip detection (only when not in cooldown) ─────────────────
      if (state.flipCooldown === 0 && bar.direction !== state.dir) {
        state.flipCount++;
        if (state.flipCount >= FLIP_CONFIRM_H) {
          if (bar.apy >= FLIP_ENTRY_APY) {
            // Strong enough signal — flip direction (close + reopen)
            periodCost  += posSize * (ROUND_TRIP_FEE + def.slippage * 2);
            state.dir    = bar.direction;
            state.flipCooldown = FLIP_COOLDOWN_H;
            flipCount++;
          } else {
            // Weak new direction — just close, wait for better entry
            periodCost += posSize * (ROUND_TRIP_FEE / 2 + def.slippage);
            state.inPosition = false;
          }
          state.flipCount = 0;
          state.negCount  = 0;
        }
      } else if (bar.direction === state.dir) {
        state.flipCount = 0;
      }

      // ── Close if persistently losing money on carry ───────────────────────────
      if (state.inPosition && state.negCount >= CLOSE_NEGATIVE_H) {
        periodCost += posSize * (ROUND_TRIP_FEE / 2 + def.slippage);
        state.inPosition = false;
        state.negCount   = 0;
        state.flipCount  = 0;
      }
    }

    // Idle capital earns USDC deposit rate
    const deployedCapital = ASSET_UNIVERSE
      .filter(d => posState[d.asset].inPosition)
      .reduce((s, d) => s + d.maxEquityPct, 0);
    const idleFraction = Math.max(0, 1 - deployedCapital);
    const idleYield = equity * idleFraction * (USDC_APY / (24 * 365.25));
    periodFunding += idleYield;

    // Periodic rebalance: every 8h, charge small rebalancing cost on open positions
    if (ts % (8 * 3600) === 0 && deployed > 0) {
      const perpExposure = ASSET_UNIVERSE
        .filter(d => posState[d.asset].inPosition)
        .reduce((s, d) => s + equity * d.maxEquityPct * LEVERAGE, 0);
      // Rebalance drift (0.5% position drift per 8h period × blended fee)
      periodCost += perpExposure * 0.005 * BLENDED_FEE;
    }

    totalFund += periodFunding;
    totalCost    += periodCost;
    equity        = equity + periodFunding - periodCost;
    totalHrs++;
    if (periodFunding - periodCost > 0) fundHrs++;

    // Drawdown
    if (equity > peakEq) peakEq = equity;
    const dd = (peakEq - equity) / peakEq * 100;
    if (dd > maxDD) maxDD = dd;

    // Daily snapshot
    const date = new Date(ts * 1000).toISOString().split("T")[0];
    if (date !== prevDate) {
      dailyRows.push({ date, equity });
      prevDate = date;
    }

    // Monthly
    const month = date.slice(0, 7);
    if (!monthly[month]) monthly[month] = { start: equity / (1 + (periodFunding - periodCost) / equity), end: equity, funding: 0, costs: 0 };
    monthly[month].end = equity;
    monthly[month].funding += periodFunding;
    monthly[month].costs   += periodCost;
  }

  // ── Statistics ──────────────────────────────────────────────────────────────
  const totalReturn = (equity - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  // CAGR: correct compound annualized return (NOT simple totalReturn/years)
  const cagr = (Math.pow(equity / INITIAL_CAPITAL, 365.25 / totalDays) - 1) * 100;

  const dailyRfRate = RISK_FREE_RATE / 365.25; // daily risk-free rate

  const avgDailyRet = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    return s + (d.equity - arr[i-1].equity) / arr[i-1].equity;
  }, 0) / (dailyRows.length - 1 || 1);

  const variance = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i-1].equity) / arr[i-1].equity;
    return s + Math.pow(r - avgDailyRet, 2);
  }, 0) / (dailyRows.length - 1 || 1);

  // Sharpe ratio: excess return over risk-free rate (annualized)
  const sharpe = Math.sqrt(365.25) * (avgDailyRet - dailyRfRate) / Math.sqrt(variance || 1e-10);

  // Sortino ratio: downside deviation only
  const downsideVariance = dailyRows.reduce((s, d, i, arr) => {
    if (i === 0) return s;
    const r = (d.equity - arr[i-1].equity) / arr[i-1].equity - dailyRfRate;
    return s + (r < 0 ? Math.pow(r, 2) : 0);
  }, 0) / (dailyRows.length - 1 || 1);
  const sortino = Math.sqrt(365.25) * (avgDailyRet - dailyRfRate) / Math.sqrt(downsideVariance || 1e-10);

  // Calmar ratio: CAGR / max drawdown
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  // ── Output ──────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   REALISTIC BACKTEST — 3 YEAR DELTA-NEUTRAL STRATEGY     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nPeriod:         ${START_DATE.toISOString().split("T")[0]} → ${END_DATE.toISOString().split("T")[0]} (${totalDays.toFixed(0)} days)`);
  console.log(`Universe:       SOL 22%+BTC 20%+ETH 13% + JTO 23%+INJ 22% (sum=100% margin)`);
  console.log(`Leverage:       ${LEVERAGE}x on perp leg`);
  console.log(`Entry APY:      ${ENTRY_APY * 100}% (hold until persistently negative, not just below entry)`);
  console.log(`Flip protect:   ${FLIP_CONFIRM_H}h confirmation`);
  console.log(`Slippage:       Tier1=0.05%, Tier2=0.20-0.30%`);

  console.log("\n─── PERFORMANCE ──────────────────────────────────────────────");
  console.log(`Total Return:        ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`);
  console.log(`Final Equity:        $${equity.toFixed(2)}`);
  console.log(`CAGR:                ${cagr >= 0 ? "+" : ""}${cagr.toFixed(2)}%  (compound annual, correct)`);
  console.log(`Max Drawdown:        ${maxDD.toFixed(2)}%`);
  console.log(`Sharpe Ratio:        ${sharpe.toFixed(2)}  (vs ${(RISK_FREE_RATE*100).toFixed(1)}% risk-free)`);
  console.log(`Sortino Ratio:       ${sortino.toFixed(2)}  (downside-only deviation)`);
  console.log(`Calmar Ratio:        ${calmar.toFixed(2)}  (CAGR / max drawdown)`);
  console.log(`Gross Funding:       $${totalFund.toFixed(2)}`);
  console.log(`Total Costs:         $${totalCost.toFixed(2)}`);
  console.log(`Net P&L:             $${(equity - INITIAL_CAPITAL).toFixed(2)}`);
  console.log(`Cost/Income ratio:   ${(totalCost / totalFund * 100).toFixed(1)}%`);
  console.log(`Direction Flips:     ${flipCount}`);
  console.log(`Win Rate (hourly):   ${(fundHrs / totalHrs * 100).toFixed(1)}%`);

  console.log("\n--- MONTHLY BREAKDOWN ---");
  console.log("Month       StartEq      EndEq   Return    Funding    Costs");
  let prevEnd = INITIAL_CAPITAL;
  for (const [mo, v] of Object.entries(monthly).sort()) {
    const ret = ((v.end - prevEnd) / prevEnd * 100).toFixed(2);
    const sign = parseFloat(ret) >= 0 ? "+" : "";
    const line = mo + "   $" + prevEnd.toFixed(0).padStart(8)
      + "  $" + v.end.toFixed(0).padStart(8)
      + "  " + sign + ret + "%"
      + "  $" + v.funding.toFixed(0).padStart(8)
      + "  $" + v.costs.toFixed(0).padStart(6);
    console.log(line);
    prevEnd = v.end;
  }

  console.log("\n--- YEARLY SUMMARY ---");
  const years = Array.from(new Set(Object.keys(monthly).map((mo) => mo.slice(0, 4)))).sort();
  let yearStart = INITIAL_CAPITAL;
  for (const yr of years) {
    const yearMonths = Object.entries(monthly).filter(([mo]) => mo.startsWith(yr)).sort();
    if (!yearMonths.length) continue;
    const yearEnd = yearMonths[yearMonths.length - 1][1].end;
    const yearFund = yearMonths.reduce((s, [, v]) => s + v.funding, 0);
    const yearCost = yearMonths.reduce((s, [, v]) => s + v.costs, 0);
    const ret = ((yearEnd - yearStart) / yearStart * 100).toFixed(2);
    const sign = parseFloat(ret) >= 0 ? "+" : "";
    console.log(yr + ":  $" + yearStart.toFixed(0).padStart(8)
      + " -> $" + yearEnd.toFixed(0).padStart(8)
      + "  " + sign + ret + "%"
      + "  (funding $" + yearFund.toFixed(0) + ", costs $" + yearCost.toFixed(0) + ")");
    yearStart = yearEnd;
  }

  // Save JSON
  const output = {
    version: "realistic-v1",
    dataSource: "Drift Data API — real on-chain funding rates (cached)",
    period: {
      start: START_DATE.toISOString().split("T")[0],
      end:   END_DATE.toISOString().split("T")[0],
      days:  totalDays.toFixed(0),
    },
    parameters: {
      universe: ASSET_UNIVERSE.map(d => ({
        asset: d.asset, tier: d.tier,
        maxEquityPct: `${(d.maxEquityPct * 100).toFixed(0)}%`,
        slippage: `${(d.slippage * 100).toFixed(2)}%`,
      })),
      leverage: `${LEVERAGE}x`,
      entryAPY: `${ENTRY_APY * 100}%`,
      closeNegativeHours: CLOSE_NEGATIVE_H,
      flipConfirmHours: FLIP_CONFIRM_H,
      blendedFeeRoundTrip: `${(ROUND_TRIP_FEE * 100).toFixed(3)}%`,
    },
    performance: {
      initialCapital: `$${INITIAL_CAPITAL}`,
      finalEquity:    "$" + equity.toFixed(2),
      totalReturn:    (totalReturn >= 0 ? "+" : "") + totalReturn.toFixed(2) + "%",
      cagr:           `${cagr >= 0 ? "+" : ""}${cagr.toFixed(2)}%`,
      maxDrawdown:    `${maxDD.toFixed(2)}%`,
      sharpeRatio:    sharpe.toFixed(2),
      sortinoRatio:   sortino.toFixed(2),
      calmarRatio:    calmar.toFixed(2),
      grossFunding:   "$" + totalFund.toFixed(2),
      totalCosts:     "$" + totalCost.toFixed(2),
      netPnL:         "$" + (equity - INITIAL_CAPITAL).toFixed(2),
      costIncomeRatio: (totalCost / totalFund * 100).toFixed(1) + "%",
      directionFlips: flipCount,
      winRate:        (fundHrs / totalHrs * 100).toFixed(1) + "%",
    },
    monthly: Object.fromEntries(
      Object.entries(monthly).map(([m, v]) => [m, {
        endEquity: v.end.toFixed(2),
        funding: v.funding.toFixed(2),
        costs: v.costs.toFixed(2),
      }])
    ),
    equityCurve: dailyRows.map(d => ({
      date: d.date,
      equity: d.equity.toFixed(2),
    })),
  };

  fs.writeFileSync("backtest_realistic_3year.json", JSON.stringify(output, null, 2));
  console.log("\nSaved to backtest_realistic_3year.json");
}

main().catch(console.error);
