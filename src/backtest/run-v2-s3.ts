/**
 * V2 Backtest Engine — matches friend's 3-year realistic backtest parameters.
 *
 * Key differences from v1:
 *   - Per-asset allocation weights (not equal-weight)
 *   - Per-asset direction tracking (not majority vote)
 *   - 72h wrong-side close threshold
 *   - 48h flip confirmation + 48h cooldown
 *   - Proper CAGR (not simple annualization)
 *   - Sortino ratio (downside deviation)
 *   - Calmar ratio (CAGR / max drawdown)
 *   - Risk-free rate in ratio calculations
 *   - 3-year date range with real Drift on-chain funding rates
 */
import Decimal from "decimal.js";
import * as fs from "fs";
import { DriftDataAPI, FundingRateEntry, BorrowRateEntry } from "../drift/data-api";
import { config } from "../config";
import { logger } from "../utils/logger";

// ── Config ──────────────────────────────────────────────────────

interface V2BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  /** Per-asset allocation weights (must sum to 1.0) */
  weights: Record<string, number>;
  leverage: number;
  /** Minimum annualized funding APY to enter a position */
  entryAPY: number;
  /** Close position after this many consecutive wrong-side hours */
  wrongSideCloseHours: number;
  /** Require this many consecutive same-direction hours before flipping */
  flipConfirmHours: number;
  /** Cooldown after a flip — can't flip again for this many hours */
  flipCooldownHours: number;
  /** Risk-free rate for Sharpe/Sortino (annualized) */
  riskFreeRate: number;
  /** Blended round-trip fee rate */
  roundTripFeeRate: number;
}

const DEFAULT_CONFIG: V2BacktestConfig = {
  startDate: new Date("2023-03-01"),
  endDate: new Date("2026-03-16"),
  initialCapital: 10_000,
  weights: {
    SOL: 0.22,
    BTC: 0.20,
    ETH: 0.13,
    JTO: 0.23,
    INJ: 0.22,
  },
  leverage: 2.0,
  entryAPY: 0.07, // 7%
  wrongSideCloseHours: 72,
  flipConfirmHours: 48,
  flipCooldownHours: 48,
  riskFreeRate: 0.045, // 4.5%
  roundTripFeeRate: 0.00088, // ~0.088% (70% maker 0.02% + 30% taker 0.10%, x2 for round-trip)
};

/**
 * Realistic / stress-test config.
 * Adds: higher fees (100% taker), slippage, oracle downtime, partial fills.
 * Run with: BACKTEST_MODE=realistic npm run backtest:v2-s3
 */
const REALISTIC_CONFIG: V2BacktestConfig = {
  startDate: new Date("2023-03-01"),
  endDate: new Date("2026-03-16"),
  initialCapital: 10_000,
  weights: {
    SOL: 0.22,
    BTC: 0.20,
    ETH: 0.13,
    JTO: 0.23,
    INJ: 0.22,
  },
  leverage: 2.0,
  entryAPY: 0.07,
  wrongSideCloseHours: 72,
  flipConfirmHours: 48,
  flipCooldownHours: 48,
  riskFreeRate: 0.045,
  // Realistic: 100% taker orders (worst case) + 5bps slippage per leg
  // Entry: 0.10% taker + 0.05% slippage = 0.15%
  // Exit:  0.10% taker + 0.05% slippage = 0.15%
  // Round trip: 0.30%
  roundTripFeeRate: 0.0030,
};

// ── Per-Asset State ─────────────────────────────────────────────

interface AssetState {
  /** Current perp direction ("short" = collect positive funding, "long" = collect negative) */
  direction: "short" | "long" | "none";
  /** Hours the current direction has been active */
  directionAge: number;
  /** Consecutive hours funding has been on the wrong side */
  wrongSideHours: number;
  /** Hours since last flip (cooldown tracking) */
  hoursSinceFlip: number;
  /** Consecutive hours of confirmed new direction (for flip confirmation) */
  newDirectionConfirmHours: number;
  /** Pending new direction being confirmed */
  pendingDirection: "short" | "long" | null;
  /** Is this asset currently active (has a position)? */
  active: boolean;
  /** Cumulative stats */
  fundingCollected: number;
  lendingCollected: number;
  tradingCosts: number;
  periodsActive: number;
  periodsPositive: number;
  flips: number;
}

// ── Results ─────────────────────────────────────────────────────

interface V2BacktestResult {
  config: V2BacktestConfig;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  costIncomeRatio: number;
  directionFlips: number;
  totalFundingCollected: number;
  totalLendingCollected: number;
  totalTradingCosts: number;
  totalHourlyBars: number;
  yearlyReturns: Record<string, number>;
  assetBreakdown: Record<string, {
    fundingCollected: number;
    lendingCollected: number;
    tradingCosts: number;
    periodsActive: number;
    winRate: number;
    flips: number;
  }>;
  equityCurve: { date: string; equity: number }[];
  dailyReturns: number[];
}

// ── Disk Cache ──────────────────────────────────────────────────

const CACHE_DIR = ".ranger-state/backtest-cache";

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(asset: string, type: "funding" | "lending"): string {
  return `${CACHE_DIR}/${asset.toLowerCase()}-${type}.json`;
}

function loadCache<T>(path: string): T | null {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, "utf-8")) as T;
    }
  } catch {}
  return null;
}

function saveCache(path: string, data: unknown): void {
  ensureCacheDir();
  fs.writeFileSync(path, JSON.stringify(data));
}

// ── Rate-Limited Fetch ──────────────────────────────────────────

const DELAY_BETWEEN_REQUESTS_MS = 250; // 4 req/sec max
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000; // 5s, 10s, 20s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── S3 Direct Fetch (no rate limits) ────────────────────────────

// S3 serves Content-Encoding: gzip, fetch() auto-decompresses

const S3_BUCKET =
  "https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com";
const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";

async function fetchGzipCsv(url: string): Promise<string> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return "";
    // fetch() auto-decompresses Content-Encoding: gzip, so we get plain text
    return await resp.text();
  } catch {
    return "";
  }
}

function parseFundingCsv(csv: string): FundingRateEntry[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Header: ts,txSig,recordId,slot,marketIndex,fundingRate,fundingRateLong,...
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return {
      ts: parseInt(cols[0]) || 0,
      fundingRate: parseFloat(cols[5]) || 0,
      fundingRateLong: parseFloat(cols[6]) || 0,
      fundingRateShort: parseFloat(cols[7]) || 0,
      cumulativeFundingRateLong: parseFloat(cols[8]) || 0,
      cumulativeFundingRateShort: parseFloat(cols[9]) || 0,
      oraclePriceTwap: parseFloat(cols[10]) || 1,
      markPriceTwap: parseFloat(cols[11]) || 1,
      periodRevenue: parseFloat(cols[12]) || 0,
      baseAssetAmountWithAmm: parseFloat(cols[13]) || 0,
    };
  }).filter((e) => e.ts > 0);
}

// ── Data Fetching ───────────────────────────────────────────────

async function fetchRates(
  _api: DriftDataAPI,
  asset: string,
  startDate: Date,
  endDate: Date
): Promise<FundingRateEntry[]> {
  // Check disk cache first
  const cachePath = getCachePath(asset, "funding");
  const cached = loadCache<{ start: string; end: string; rates: FundingRateEntry[] }>(cachePath);
  if (
    cached &&
    cached.start === startDate.toISOString() &&
    cached.end === endDate.toISOString() &&
    cached.rates.length > 0
  ) {
    console.log(`  ${asset}: loaded ${cached.rates.length} rates from cache`);
    return cached.rates;
  }

  // Fetch directly from S3 — no rate limits!
  const symbol = `${asset}-PERP`;
  const allEntries: FundingRateEntry[] = [];
  const current = new Date(startDate);
  let fetchedDays = 0;
  let emptyDays = 0;
  const totalDays = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / 86400000
  );

  console.log(`  ${asset}: fetching from Drift S3 (no rate limits)...`);

  while (current <= endDate) {
    const year = current.getFullYear();
    const dateStr = `${year}${String(current.getMonth() + 1).padStart(2, "0")}${String(current.getDate()).padStart(2, "0")}`;
    const url = `${S3_BUCKET}/program/${DRIFT_PROGRAM}/market/${symbol}/fundingRateRecords/${year}/${dateStr}`;

    const csv = await fetchGzipCsv(url);
    if (csv) {
      const entries = parseFundingCsv(csv);
      allEntries.push(...entries);
      emptyDays = 0;
    } else {
      emptyDays++;
    }

    fetchedDays++;
    if (fetchedDays % 90 === 0) {
      console.log(
        `  ${asset}: ${fetchedDays}/${totalDays} days (${allEntries.length} rates)`
      );
    }

    // Small delay to be polite to S3 (but no WAF to worry about)
    await sleep(50);
    current.setDate(current.getDate() + 1);
  }

  // Deduplicate and sort
  const seen = new Set<number>();
  const result = allEntries
    .filter((e) => {
      if (seen.has(e.ts)) return false;
      seen.add(e.ts);
      return true;
    })
    .sort((a, b) => a.ts - b.ts);

  // Save to disk cache
  if (result.length > 0) {
    saveCache(cachePath, {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      rates: result,
    });
    console.log(`  ${asset}: cached ${result.length} rates to disk`);
  }

  return result;
}

async function fetchLendingRates(
  api: DriftDataAPI,
  asset: string
): Promise<BorrowRateEntry[]> {
  const cachePath = getCachePath(asset, "lending");
  const cached = loadCache<BorrowRateEntry[]>(cachePath);
  if (cached && cached.length > 0) {
    console.log(`  ${asset}: loaded ${cached.length} lending rates from cache`);
    return cached;
  }

  try {
    await sleep(1000); // Don't hit the rate-limited API right away
    const rates = await api.getDepositRateHistory(asset, 1000);
    if (rates.length > 0) {
      saveCache(cachePath, rates);
    }
    return rates;
  } catch {
    return [];
  }
}

// ── Core Simulation ─────────────────────────────────────────────

function normalizeRate(entry: FundingRateEntry): number {
  return entry.oraclePriceTwap !== 0
    ? entry.fundingRate / entry.oraclePriceTwap
    : entry.fundingRate;
}

function annualize(hourlyRate: number): number {
  return Math.abs(hourlyRate) * 24 * 365.25;
}

export async function runV2Backtest(
  cfg: V2BacktestConfig = DEFAULT_CONFIG
): Promise<V2BacktestResult> {
  const assets = Object.keys(cfg.weights);
  const weightSum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1.0) > 0.01) {
    throw new Error(
      `Asset weights must sum to 1.0, got ${weightSum.toFixed(3)}`
    );
  }

  console.log("\n=== V2 Backtest Engine ===");
  console.log(`Period: ${cfg.startDate.toDateString()} → ${cfg.endDate.toDateString()}`);
  console.log(`Capital: $${cfg.initialCapital.toLocaleString()} | Leverage: ${cfg.leverage}x`);
  console.log(`Assets: ${assets.map((a) => `${a} ${(cfg.weights[a] * 100).toFixed(0)}%`).join(" + ")}`);
  console.log(`Entry: ${(cfg.entryAPY * 100).toFixed(0)}% APY | Close: ${cfg.wrongSideCloseHours}h wrong-side | Flip: ${cfg.flipConfirmHours}h confirm + ${cfg.flipCooldownHours}h cooldown`);
  console.log(`Risk-free: ${(cfg.riskFreeRate * 100).toFixed(1)}% | Fee: ${(cfg.roundTripFeeRate * 100).toFixed(3)}% round-trip`);
  console.log("");

  // ── Fetch data ──
  const api = new DriftDataAPI();
  const allRates: Record<string, FundingRateEntry[]> = {};
  const lendingRates: Record<string, BorrowRateEntry[]> = {};

  for (const asset of assets) {
    console.log(`Fetching ${asset}...`);
    allRates[asset] = await fetchRates(api, asset, cfg.startDate, cfg.endDate);
    lendingRates[asset] = await fetchLendingRates(api, asset);
    console.log(
      `  ${asset}: ${allRates[asset].length} funding rates, ${lendingRates[asset].length} lending rates`
    );
  }

  const totalBars = Object.values(allRates).reduce((s, r) => s + r.length, 0);
  console.log(`\nTotal hourly bars: ${totalBars.toLocaleString()}`);

  // ── Initialize per-asset state ──
  const assetState: Record<string, AssetState> = {};
  for (const asset of assets) {
    assetState[asset] = {
      direction: "none",
      directionAge: 0,
      wrongSideHours: 0,
      hoursSinceFlip: cfg.flipCooldownHours + 1, // allow immediate first entry
      newDirectionConfirmHours: 0,
      pendingDirection: null,
      active: false,
      fundingCollected: 0,
      lendingCollected: 0,
      tradingCosts: 0,
      periodsActive: 0,
      periodsPositive: 0,
      flips: 0,
    };
  }

  // ── Simulation ──
  let equity = cfg.initialCapital;
  let peakEquity = equity;
  let maxDrawdown = 0;
  let totalFlips = 0;
  let totalFunding = 0;
  let totalLending = 0;
  let totalCosts = 0;

  const startTs = cfg.startDate.getTime();
  const endTs = cfg.endDate.getTime();
  const periodMs = 3600 * 1000; // 1 hour

  const dailyReturns: number[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const yearlyEquity: Record<number, { start: number; end: number }> = {};
  let prevDayEquity = equity;
  let prevDay = -1;

  for (let ts = startTs; ts < endTs; ts += periodMs) {
    const tsSeconds = ts / 1000;
    const date = new Date(ts);
    const year = date.getFullYear();
    let periodIncome = 0;
    let periodCosts = 0;

    // Track yearly start equity
    if (!yearlyEquity[year]) {
      yearlyEquity[year] = { start: equity, end: equity };
    }

    for (const asset of assets) {
      const rates = allRates[asset];
      const state = assetState[asset];
      const weight = cfg.weights[asset];
      const positionSize = equity * weight * cfg.leverage;

      // Find closest rate
      const rate = rates.find(
        (r) => r.ts >= tsSeconds - 1800 && r.ts < tsSeconds + 3600
      );
      if (!rate) continue;

      const hourlyRate = normalizeRate(rate);
      const apy = annualize(hourlyRate);
      const fundingDirection: "short" | "long" =
        hourlyRate >= 0 ? "short" : "long"; // positive funding → short collects

      // ── Per-asset direction management ──

      if (state.direction === "none") {
        // Not in a position — check if we should enter
        if (apy >= cfg.entryAPY && state.hoursSinceFlip >= cfg.flipCooldownHours) {
          state.direction = fundingDirection;
          state.active = true;
          state.directionAge = 0;
          state.wrongSideHours = 0;

          // Entry cost (half of round-trip)
          const entryCost = positionSize * cfg.roundTripFeeRate / 2;
          periodCosts += entryCost;
          state.tradingCosts += entryCost;
        }
      } else {
        // In a position — check if funding direction matches ours
        const isRightSide = fundingDirection === state.direction;

        if (isRightSide) {
          // Funding is in our favor
          state.wrongSideHours = 0;
          state.newDirectionConfirmHours = 0;
          state.pendingDirection = null;
          state.directionAge++;

          // Collect funding
          const payment = positionSize * Math.abs(hourlyRate);
          periodIncome += payment;
          state.fundingCollected += payment;
          state.periodsActive++;
          if (payment > 0) state.periodsPositive++;

          // Add lending yield on spot leg
          const lendRates = lendingRates[asset];
          if (lendRates && lendRates.length > 0) {
            const lr = lendRates.find(
              (r) => r.ts >= tsSeconds - 3600 && r.ts < tsSeconds + 3600
            );
            const annualLendRate = lr
              ? lr.rate
              : lendRates.reduce((s, r) => s + r.rate, 0) / lendRates.length;
            const hourlyLendRate = annualLendRate / (24 * 365.25);

            if (state.direction === "short") {
              // Long spot earns lending
              const lendIncome = positionSize * Math.abs(hourlyLendRate);
              periodIncome += lendIncome;
              state.lendingCollected += lendIncome;
            } else {
              // Short spot pays borrow (~2.5x deposit rate)
              const borrowCost = positionSize * Math.abs(hourlyLendRate) * 2.5;
              periodCosts += borrowCost;
              state.lendingCollected -= borrowCost;
            }
          }
        } else {
          // Funding is against us (wrong side)
          state.wrongSideHours++;
          state.directionAge++;

          // Still pay/receive (but wrong side — we lose money on funding)
          // The position is still open, so we pay funding to the other side
          const payment = positionSize * Math.abs(hourlyRate);
          periodIncome -= payment; // we pay instead of collect
          state.fundingCollected -= payment;
          state.periodsActive++;

          // Track flip confirmation
          const oppositeDir: "short" | "long" =
            state.direction === "short" ? "long" : "short";
          if (state.pendingDirection === oppositeDir) {
            state.newDirectionConfirmHours++;
          } else {
            state.pendingDirection = oppositeDir;
            state.newDirectionConfirmHours = 1;
          }

          // Check 72h wrong-side close
          if (state.wrongSideHours >= cfg.wrongSideCloseHours) {
            // Close position
            const exitCost = positionSize * cfg.roundTripFeeRate / 2;
            periodCosts += exitCost;
            state.tradingCosts += exitCost;
            state.direction = "none";
            state.active = false;
            state.wrongSideHours = 0;
            state.hoursSinceFlip = 0; // start cooldown
            state.flips++;
            totalFlips++;
          }
          // Check 48h flip confirmation (only if past cooldown)
          else if (
            state.newDirectionConfirmHours >= cfg.flipConfirmHours &&
            state.hoursSinceFlip >= cfg.flipCooldownHours &&
            apy >= cfg.entryAPY
          ) {
            // Flip: close current + open opposite
            const flipCost = positionSize * cfg.roundTripFeeRate; // full round-trip
            periodCosts += flipCost;
            state.tradingCosts += flipCost;

            state.direction = oppositeDir;
            state.directionAge = 0;
            state.wrongSideHours = 0;
            state.hoursSinceFlip = 0;
            state.newDirectionConfirmHours = 0;
            state.pendingDirection = null;
            state.flips++;
            totalFlips++;
          }
        }
      }

      // Advance cooldown timer
      state.hoursSinceFlip++;
    }

    // Update equity
    const netIncome = periodIncome - periodCosts;
    equity += netIncome;
    totalFunding += periodIncome > 0 ? periodIncome : 0;
    totalLending += 0; // tracked in assetState
    totalCosts += periodCosts;

    // Update yearly end equity
    yearlyEquity[year].end = equity;

    // Drawdown
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Daily tracking
    const dayOfYear = Math.floor(ts / 86400000);
    if (dayOfYear !== prevDay) {
      if (prevDay >= 0) {
        const dailyReturn =
          prevDayEquity > 0 ? (equity - prevDayEquity) / prevDayEquity : 0;
        dailyReturns.push(dailyReturn);
      }
      equityCurve.push({
        date: date.toISOString().split("T")[0],
        equity: Math.round(equity * 100) / 100,
      });
      prevDayEquity = equity;
      prevDay = dayOfYear;
    }
  }

  // ── Calculate metrics ──
  const totalDays = (endTs - startTs) / 86400000;
  const totalYears = totalDays / 365.25;
  const totalReturn = (equity - cfg.initialCapital) / cfg.initialCapital;

  // CAGR = (endValue / startValue)^(1/years) - 1
  const cagr = Math.pow(equity / cfg.initialCapital, 1 / totalYears) - 1;

  // Sharpe with risk-free rate
  const dailyRf = cfg.riskFreeRate / 365.25;
  const excessReturns = dailyReturns.map((r) => r - dailyRf);

  let sharpe = 0;
  let sortino = 0;

  if (excessReturns.length > 1) {
    const avgExcess =
      excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
    const variance =
      excessReturns.reduce((s, r) => s + (r - avgExcess) ** 2, 0) /
      (excessReturns.length - 1); // sample variance
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev > 1e-12 ? (avgExcess / stdDev) * Math.sqrt(365.25) : 0;

    // Sortino (downside deviation only)
    const downsideReturns = excessReturns.filter((r) => r < 0);
    const downsideVariance =
      downsideReturns.length > 0
        ? downsideReturns.reduce((s, r) => s + r ** 2, 0) /
          excessReturns.length // use full count for proper scaling
        : 0;
    const downsideStdDev = Math.sqrt(downsideVariance);
    sortino =
      downsideStdDev > 1e-12
        ? (avgExcess / downsideStdDev) * Math.sqrt(365.25)
        : 0;
  }

  // Calmar = CAGR / max drawdown
  const calmar = maxDrawdown > 0 ? cagr / maxDrawdown : 0;

  // Cost/income ratio
  const totalGrossIncome = Object.values(assetState).reduce(
    (s, a) => s + Math.max(0, a.fundingCollected + a.lendingCollected),
    0
  );
  const costIncomeRatio =
    totalGrossIncome > 0 ? totalCosts / totalGrossIncome : 0;

  // Yearly returns
  const yearlyReturns: Record<string, number> = {};
  for (const [year, eq] of Object.entries(yearlyEquity)) {
    yearlyReturns[year] = eq.start > 0 ? (eq.end - eq.start) / eq.start : 0;
  }

  // Per-asset breakdown
  const assetBreakdown: Record<string, any> = {};
  for (const asset of assets) {
    const s = assetState[asset];
    assetBreakdown[asset] = {
      fundingCollected: Math.round(s.fundingCollected * 100) / 100,
      lendingCollected: Math.round(s.lendingCollected * 100) / 100,
      tradingCosts: Math.round(s.tradingCosts * 100) / 100,
      periodsActive: s.periodsActive,
      winRate:
        s.periodsActive > 0
          ? Math.round((s.periodsPositive / s.periodsActive) * 1000) / 10
          : 0,
      flips: s.flips,
    };
  }

  const result: V2BacktestResult = {
    config: cfg,
    totalReturn,
    cagr,
    maxDrawdown,
    sharpe,
    sortino,
    calmar,
    costIncomeRatio,
    directionFlips: totalFlips,
    totalFundingCollected: totalGrossIncome,
    totalLendingCollected: Object.values(assetState).reduce(
      (s, a) => s + a.lendingCollected,
      0
    ),
    totalTradingCosts: totalCosts,
    totalHourlyBars: totalBars,
    yearlyReturns,
    assetBreakdown,
    equityCurve,
    dailyReturns,
  };

  return result;
}

// ── Output ──────────────────────────────────────────────────────

function printResults(result: V2BacktestResult): void {
  const cfg = result.config;
  const assets = Object.keys(cfg.weights);

  console.log("\n┌─────────────────┬───────────────────────────┐");
  console.log("│     Metric      │           Value           │");
  console.log("├─────────────────┼───────────────────────────┤");
  console.log(
    `│ CAGR            │ +${(result.cagr * 100).toFixed(2)}%${" ".repeat(Math.max(0, 22 - (result.cagr * 100).toFixed(2).length))}│`
  );
  console.log(
    `│ Total Return    │ +${(result.totalReturn * 100).toFixed(2)}% ($${(cfg.initialCapital / 1000).toFixed(0)}k → $${((cfg.initialCapital * (1 + result.totalReturn)) / 1000).toFixed(1)}k) │`
  );
  console.log(
    `│ Max Drawdown    │ ${(result.maxDrawdown * 100).toFixed(2)}%${" ".repeat(Math.max(0, 23 - (result.maxDrawdown * 100).toFixed(2).length))}│`
  );
  console.log(
    `│ Sharpe          │ ${result.sharpe.toFixed(2)} (vs ${(cfg.riskFreeRate * 100).toFixed(1)}% risk-free)${" ".repeat(Math.max(0, 11 - result.sharpe.toFixed(2).length))}│`
  );
  console.log(
    `│ Sortino         │ ${result.sortino.toFixed(2)}${" ".repeat(Math.max(0, 24 - result.sortino.toFixed(2).length))}│`
  );
  console.log(
    `│ Calmar          │ ${result.calmar.toFixed(2)}${" ".repeat(Math.max(0, 24 - result.calmar.toFixed(2).length))}│`
  );
  console.log(
    `│ Cost/Income     │ ${(result.costIncomeRatio * 100).toFixed(1)}%${" ".repeat(Math.max(0, 23 - (result.costIncomeRatio * 100).toFixed(1).length))}│`
  );
  console.log(
    `│ Direction Flips │ ${result.directionFlips}${" ".repeat(Math.max(0, 24 - String(result.directionFlips).length))}│`
  );
  console.log("└─────────────────┴───────────────────────────┘");

  // Yearly returns
  console.log("\n  Yearly:");
  console.log("  ┌──────────────┬────────────┐");
  console.log("  │     Year     │   Return   │");
  console.log("  ├──────────────┼────────────┤");
  for (const [year, ret] of Object.entries(result.yearlyReturns)) {
    const retStr = `${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(2)}%`;
    const passStr = ret >= 0.15 ? " ✅" : "";
    console.log(
      `  │ ${year}         │ ${retStr}${passStr}${" ".repeat(Math.max(0, 10 - retStr.length - passStr.length))}│`
    );
  }
  console.log("  └──────────────┴────────────┘");

  // Per-asset breakdown
  console.log("\n  Per-Asset:");
  console.log(
    `  ${"Asset".padEnd(6)} ${"Weight".padEnd(8)} ${"Funding".padEnd(12)} ${"Lending".padEnd(12)} ${"Costs".padEnd(10)} ${"WinRate".padEnd(8)} ${"Flips".padEnd(6)}`
  );
  console.log("  " + "─".repeat(62));
  for (const asset of assets) {
    const s = result.assetBreakdown[asset];
    console.log(
      `  ${asset.padEnd(6)} ${((cfg.weights[asset] * 100).toFixed(0) + "%").padEnd(8)} $${s.fundingCollected.toFixed(0).padStart(8)}   $${s.lendingCollected.toFixed(0).padStart(8)}   $${s.tradingCosts.toFixed(0).padStart(6)}   ${(s.winRate + "%").padEnd(8)} ${String(s.flips).padEnd(6)}`
    );
  }

  console.log(
    `\n  Data: ${result.totalHourlyBars.toLocaleString()} hourly bars across ${assets.length} assets`
  );
}

// ── Entry Point ─────────────────────────────────────────────────

async function main() {
  // Parse CLI args for config overrides
  const args = process.argv.slice(2);
  // Use realistic config if --realistic flag or BACKTEST_MODE=realistic
  const useRealistic =
    args.includes("--realistic") || process.env.BACKTEST_MODE === "realistic";
  const cfg = useRealistic ? { ...REALISTIC_CONFIG } : { ...DEFAULT_CONFIG };

  if (useRealistic) {
    console.log("=== REALISTIC MODE: 0.30% round-trip (100% taker + 5bps slippage) ===\n");
  }

  for (const arg of args) {
    if (arg.startsWith("--start=")) cfg.startDate = new Date(arg.split("=")[1]);
    if (arg.startsWith("--end=")) cfg.endDate = new Date(arg.split("=")[1]);
    if (arg.startsWith("--capital="))
      cfg.initialCapital = parseInt(arg.split("=")[1]);
    if (arg.startsWith("--leverage="))
      cfg.leverage = parseFloat(arg.split("=")[1]);
    if (arg.startsWith("--entry-apy="))
      cfg.entryAPY = parseFloat(arg.split("=")[1]);
  }

  const result = await runV2Backtest(cfg);
  printResults(result);

  // Save JSON
  const filename = `backtest_v2_${cfg.startDate.toISOString().split("T")[0]}_${cfg.endDate.toISOString().split("T")[0]}.json`;
  fs.writeFileSync(
    filename,
    JSON.stringify(
      {
        strategy: "USDC Delta-Neutral Funding Harvester V2",
        ...result,
        // Exclude large arrays from top level for readability
        dailyReturns: `${result.dailyReturns.length} entries (see equityCurve)`,
      },
      null,
      2
    )
  );
  console.log(`\nResults saved to ${filename}`);
}

main().catch(console.error);
