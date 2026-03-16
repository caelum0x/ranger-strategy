import Decimal from "decimal.js";
import * as fs from "fs";
import { DriftDataAPI, FundingRateEntry, BorrowRateEntry } from "../drift/data-api";
import { BinanceManager } from "../binance/client";
import { AssetBacktestStats, BacktestResult, FundingRate } from "../strategy/types";
import { config } from "../config";
import { logger } from "../utils/logger";

interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: Decimal;
  assets: string[];
  maxLeverage: Decimal;
  maxDrawdownPct: Decimal;
  rebalanceHours: number;
  /** "drift-only" uses Drift Data API rates; "cross-venue" uses Binance */
  mode: "drift-only" | "cross-venue";
  /** Override the global MIN_FUNDING_APY for backtesting (default: use config) */
  minFundingAPY?: Decimal;
}

interface PeriodResult {
  timestamp: number;
  fundingIncome: Decimal;
  lendingIncome: Decimal;
  tradingCosts: Decimal;
  netIncome: Decimal;
  direction: "short" | "long"; // perp direction
  activeAssets: string[];
}

/**
 * Fetch historical funding rates from Drift Data API by iterating dates.
 * Returns rates sorted by timestamp ascending.
 */
async function fetchDriftHistoricalRates(
  api: DriftDataAPI,
  asset: string,
  startDate: Date,
  endDate: Date
): Promise<FundingRateEntry[]> {
  const allEntries: FundingRateEntry[] = [];
  const symbol = `${asset}-PERP`;

  // Fetch by date range — iterate day by day
  const current = new Date(startDate);
  while (current <= endDate) {
    try {
      const entries = await api.getFundingRatesByDate(
        symbol,
        current.getFullYear(),
        current.getMonth() + 1,
        current.getDate()
      );
      allEntries.push(...entries);
    } catch {
      // Some days may not have data — skip
    }
    current.setDate(current.getDate() + 1);
  }

  // Deduplicate and sort by timestamp
  const seen = new Set<number>();
  return allEntries
    .filter((e) => {
      if (seen.has(e.ts)) return false;
      seen.add(e.ts);
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Fetch deposit (lending) rate history from Drift Data API.
 */
async function fetchDriftLendingRates(
  api: DriftDataAPI,
  asset: string,
  limit: number = 500
): Promise<BorrowRateEntry[]> {
  try {
    return await api.getDepositRateHistory(asset, limit);
  } catch {
    return [];
  }
}

export async function runBacktest(
  cfg: BacktestConfig
): Promise<BacktestResult> {
  logger.info("Starting backtest", {
    mode: cfg.mode,
    startDate: cfg.startDate.toISOString(),
    endDate: cfg.endDate.toISOString(),
    initialCapital: cfg.initialCapital.toFixed(2),
    assets: cfg.assets,
  });

  const api = new DriftDataAPI();
  const isDriftOnly = cfg.mode === "drift-only";
  const minAPYThreshold = cfg.minFundingAPY ?? config.minFundingAPY;

  // Fetch historical funding rates
  const allRates: Record<string, FundingRateEntry[]> = {};
  const lendingRates: Record<string, BorrowRateEntry[]> = {};

  for (const asset of cfg.assets) {
    if (isDriftOnly) {
      // Use Drift Data API for drift-only mode
      allRates[asset] = await fetchDriftHistoricalRates(
        api,
        asset,
        cfg.startDate,
        cfg.endDate
      );
      logger.info(
        `Fetched ${allRates[asset].length} Drift funding rates for ${asset}`
      );

      // Fetch lending rates for spot yield
      lendingRates[asset] = await fetchDriftLendingRates(api, asset);
      logger.info(
        `Fetched ${lendingRates[asset].length} lending rates for ${asset}`
      );
    } else {
      // Cross-venue: use Binance for perp funding
      const binance = new BinanceManager();
      await binance.initialize();
      const binanceRates = await binance.getHistoricalFundingRates(
        asset,
        cfg.startDate.getTime(),
        1000
      );
      // Convert to FundingRateEntry format
      allRates[asset] = binanceRates.map((r: FundingRate) => ({
        ts: r.timestamp / 1000,
        fundingRate: r.rate.toNumber(),
        fundingRateLong: r.rate.toNumber(),
        fundingRateShort: -r.rate.toNumber(),
        oraclePriceTwap: 1, // normalized
        markPriceTwap: 1,
        periodRevenue: 0,
        baseAssetAmountWithAmm: 0,
        cumulativeFundingRateLong: 0,
        cumulativeFundingRateShort: 0,
      }));
      await binance.shutdown();
      logger.info(
        `Fetched ${allRates[asset].length} Binance funding rates for ${asset}`
      );
    }
  }

  // Per-asset performance tracking
  const assetStats: Record<
    string,
    {
      fundingCollected: Decimal;
      lendingCollected: Decimal;
      periodsActive: number;
      periodsPositive: number;
    }
  > = {};
  for (const asset of cfg.assets) {
    assetStats[asset] = {
      fundingCollected: new Decimal(0),
      lendingCollected: new Decimal(0),
      periodsActive: 0,
      periodsPositive: 0,
    };
  }

  // Simulate strategy
  let equity = cfg.initialCapital;
  let peakEquity = equity;
  let maxDrawdown = new Decimal(0);
  let totalFunding = new Decimal(0);
  let totalLending = new Decimal(0);
  let totalTrades = 0;
  let wins = 0;
  let directionFlips = 0;
  let skippedBelowThreshold = 0;
  const dailyReturns: { date: Date; return: Decimal }[] = [];
  const periodResults: PeriodResult[] = [];

  // Group funding rates into 1h periods (Drift settles hourly)
  const startTs = cfg.startDate.getTime();
  const endTs = cfg.endDate.getTime();
  const periodMs = 3600 * 1000; // 1 hour (Drift settlement frequency)

  let prevEquity = equity;
  let prevDirection: "short" | "long" = "short";
  // Drift fee tiers (taker fee for market orders + maker rebate for limit orders)
  // Tier 1 (default): taker 0.10%, maker 0.02%
  // Our strategy uses limit orders (slippage-protected) → ~maker rate
  // Round-trip cost = entry + exit = ~0.04% for limit orders, ~0.20% for market orders
  // Use blended rate: assume 70% maker, 30% taker
  const makerFeeRate = new Decimal("0.0002"); // 0.02%
  const takerFeeRate = new Decimal("0.0010"); // 0.10%
  const blendedFeeRate = makerFeeRate.mul("0.7").add(takerFeeRate.mul("0.3")); // ~0.044%
  const tradingCostRate = blendedFeeRate.mul(2); // round-trip (entry + exit) ≈ 0.088%

  for (let ts = startTs; ts < endTs; ts += periodMs) {
    let periodFunding = new Decimal(0);
    let periodLending = new Decimal(0);
    const activeAssets: string[] = [];
    const tsSeconds = ts / 1000;

    for (const asset of cfg.assets) {
      const rates = allRates[asset];

      // Find the closest rate entry for this period
      const rate = rates.find(
        (r) =>
          r.ts >= tsSeconds - 1800 && r.ts < tsSeconds + 3600
      );

      if (!rate) continue;

      // Compute normalized hourly rate
      const hourlyRate =
        rate.oraclePriceTwap !== 0
          ? rate.fundingRate / rate.oraclePriceTwap
          : rate.fundingRate;

      const absRate = Math.abs(hourlyRate);
      const annualizedAbs = absRate * 24 * 365.25;

      // Skip if below min threshold
      if (annualizedAbs < minAPYThreshold.toNumber()) {
        skippedBelowThreshold++;
        continue;
      }

      // Bi-directional: determine which side to take
      // Positive funding → short perp (shorts collect from longs)
      // Negative funding → long perp (longs collect from shorts)
      const positionSize = equity.div(cfg.assets.length);
      const fundingPayment = positionSize.mul(absRate);
      periodFunding = periodFunding.add(fundingPayment);
      activeAssets.push(asset);

      // Track per-asset stats
      assetStats[asset].fundingCollected =
        assetStats[asset].fundingCollected.add(fundingPayment);
      assetStats[asset].periodsActive++;
      if (fundingPayment.gt(0)) assetStats[asset].periodsPositive++;

      // Add lending yield on spot leg (only in drift-only mode)
      // Long spot earns lending yield; short spot incurs borrow cost
      if (isDriftOnly) {
        const lendRates = lendingRates[asset];
        if (lendRates && lendRates.length > 0) {
          const lendRate = lendRates.find(
            (r) => r.ts >= tsSeconds - 3600 && r.ts < tsSeconds + 3600
          );
          const annualLendRate = lendRate
            ? lendRate.rate
            : lendRates.reduce((s, r) => s + r.rate, 0) / lendRates.length;
          const hourlyLendRate = annualLendRate / (24 * 365.25);

          if (hourlyRate >= 0) {
            // Positive funding → long spot → earns lending yield
            const lendingIncome = positionSize.mul(Math.abs(hourlyLendRate));
            periodLending = periodLending.add(lendingIncome);
            assetStats[asset].lendingCollected =
              assetStats[asset].lendingCollected.add(lendingIncome);
          } else {
            // Negative funding → short spot (borrowed) → pays borrow cost
            // Borrow rate is typically ~2-3x the deposit rate
            const borrowMultiplier = 2.5; // borrow rate ≈ 2.5x deposit rate
            const hourlyBorrowRate = Math.abs(hourlyLendRate) * borrowMultiplier;
            const borrowCost = positionSize.mul(hourlyBorrowRate);
            periodLending = periodLending.sub(borrowCost);
            assetStats[asset].lendingCollected =
              assetStats[asset].lendingCollected.sub(borrowCost);
          }
        }
      }
    }

    // Determine direction for this period (majority vote across assets)
    const currentDirection: "short" | "long" = (() => {
      let positiveCount = 0;
      let negativeCount = 0;
      for (const asset of cfg.assets) {
        const rates = allRates[asset];
        const rate = rates.find(
          (r) => r.ts >= tsSeconds - 1800 && r.ts < tsSeconds + 3600
        );
        if (rate) {
          const hr =
            rate.oraclePriceTwap !== 0
              ? rate.fundingRate / rate.oraclePriceTwap
              : rate.fundingRate;
          if (hr >= 0) positiveCount++;
          else negativeCount++;
        }
      }
      return positiveCount >= negativeCount ? "short" : "long";
    })();

    // Trading costs: incurred when direction flips (need to reverse all legs)
    let periodTradingCost = new Decimal(0);
    if (currentDirection !== prevDirection && activeAssets.length > 0) {
      // Full reversal = close + re-open = 2x trading cost on deployed capital
      periodTradingCost = equity
        .mul(activeAssets.length)
        .div(cfg.assets.length)
        .mul(tradingCostRate);
      directionFlips++;
      prevDirection = currentDirection;
    }

    // Amortized rebalance cost (periodic delta rebalancing)
    const rebalanceCost = equity
      .mul(new Decimal("0.0002"))
      .div(new Decimal(cfg.rebalanceHours));

    const totalCost = periodTradingCost.add(rebalanceCost);
    const netIncome = periodFunding.add(periodLending).sub(totalCost);
    equity = equity.add(netIncome);
    totalFunding = totalFunding.add(periodFunding);
    totalLending = totalLending.add(periodLending);

    if (periodFunding.gt(0)) wins++;
    totalTrades++;

    // Track drawdown
    if (equity.gt(peakEquity)) peakEquity = equity;
    const drawdown = peakEquity.sub(equity).div(peakEquity).mul(100);
    if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;

    // Circuit breaker
    if (drawdown.gt(cfg.maxDrawdownPct)) {
      logger.warn(
        `Backtest circuit breaker at ${new Date(ts).toISOString()} | drawdown: ${drawdown.toFixed(2)}%`
      );
    }

    // Daily snapshot
    const currentDate = new Date(ts);
    if (
      dailyReturns.length === 0 ||
      currentDate.getDate() !==
        dailyReturns[dailyReturns.length - 1].date.getDate()
    ) {
      const dailyReturn = prevEquity.isZero()
        ? new Decimal(0)
        : equity.sub(prevEquity).div(prevEquity);
      dailyReturns.push({ date: currentDate, return: dailyReturn });
      prevEquity = equity;
    }

    periodResults.push({
      timestamp: ts,
      fundingIncome: periodFunding,
      lendingIncome: periodLending,
      tradingCosts: totalCost,
      netIncome,
      direction: currentDirection,
      activeAssets,
    });
  }

  // Calculate results
  const totalDays = (endTs - startTs) / (86400 * 1000);
  const totalReturn = equity.sub(cfg.initialCapital).div(cfg.initialCapital);
  const annualizedReturn = totalReturn.mul(new Decimal(365.25).div(totalDays));

  // Sharpe ratio
  const avgDailyReturn = dailyReturns
    .reduce((sum, d) => sum.add(d.return), new Decimal(0))
    .div(dailyReturns.length || 1);

  const dailyVariance = dailyReturns
    .reduce(
      (sum, d) => sum.add(d.return.sub(avgDailyReturn).pow(2)),
      new Decimal(0)
    )
    .div(dailyReturns.length || 1);

  const dailyStdDev = dailyVariance.sqrt();
  const sharpeRatio = dailyStdDev.isZero()
    ? new Decimal(0)
    : avgDailyReturn.div(dailyStdDev).mul(new Decimal(365.25).sqrt());

  const result: BacktestResult = {
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    sharpeRatio,
    totalFundingCollected: totalFunding,
    totalLendingCollected: totalLending,
    totalTrades,
    winRate:
      totalTrades > 0 ? new Decimal(wins).div(totalTrades) : new Decimal(0),
    directionFlips,
    dailyReturns,
    assetBreakdown: assetStats,
  };

  logger.info("Backtest complete", {
    mode: cfg.mode,
    minFundingAPY: `${minAPYThreshold.mul(100).toFixed(1)}%`,
    skippedBelowThreshold,
    totalReturn: `${totalReturn.mul(100).toFixed(2)}%`,
    annualizedReturn: `${annualizedReturn.mul(100).toFixed(2)}%`,
    maxDrawdown: `${maxDrawdown.toFixed(2)}%`,
    sharpeRatio: sharpeRatio.toFixed(2),
    totalFundingCollected: `$${totalFunding.toFixed(2)}`,
    totalLendingCollected: `$${totalLending.toFixed(2)}`,
    winRate: `${result.winRate.mul(100).toFixed(1)}%`,
    directionFlips,
  });

  return result;
}

// Entry point
async function main() {
  const mode = config.strategyMode;

  const result = await runBacktest({
    startDate: new Date("2025-09-01"),
    endDate: new Date("2026-03-09"),
    initialCapital: new Decimal(10000),
    assets: config.targetAssets,
    maxLeverage: config.maxLeverage,
    maxDrawdownPct: config.maxDrawdownPct,
    rebalanceHours: config.rebalanceIntervalMs / 3600000,
    mode,
  });

  console.log("\n=== BACKTEST RESULTS ===");
  console.log(`Mode: ${mode}`);
  console.log(`Min Funding APY: ${config.minFundingAPY.mul(100).toFixed(1)}%`);
  console.log(
    `Period: ${result.startDate.toDateString()} → ${result.endDate.toDateString()}`
  );
  console.log(`Total Return: ${result.totalReturn.mul(100).toFixed(2)}%`);
  console.log(
    `Annualized Return: ${result.annualizedReturn.mul(100).toFixed(2)}%`
  );
  console.log(`Max Drawdown: ${result.maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
  console.log(
    `Total Funding Collected: $${result.totalFundingCollected.toFixed(2)}`
  );
  console.log(
    `Total Lending Collected: $${result.totalLendingCollected.toFixed(2)}`
  );
  console.log(`Win Rate: ${result.winRate.mul(100).toFixed(1)}%`);
  console.log(`Total Periods: ${result.totalTrades}`);
  console.log(`Direction Flips: ${result.directionFlips}`);

  // Print per-asset breakdown
  console.log("\n=== PER-ASSET BREAKDOWN ===");
  const perAssetCapital = new Decimal(10000).div(config.targetAssets.length);
  for (const asset of config.targetAssets) {
    const s = result.assetBreakdown?.[asset];
    if (!s) continue;
    const assetAPY =
      s.periodsActive > 0
        ? s.fundingCollected
            .div(perAssetCapital)
            .mul(24 * 365.25)
            .div(s.periodsActive)
            .mul(100)
        : new Decimal(0);
    console.log(
      `  ${asset}: funding=$${s.fundingCollected.toFixed(2)}, lending=$${s.lendingCollected.toFixed(2)}, periods=${s.periodsActive}, winRate=${s.periodsActive > 0 ? ((s.periodsPositive / s.periodsActive) * 100).toFixed(1) : 0}%, estAPY=${assetAPY.toFixed(1)}%`
    );
  }

  // Save results to JSON for submission
  const output = {
    strategy: "USDC Delta-Neutral Funding Harvester",
    mode,
    config: {
      minFundingAPY: `${config.minFundingAPY.mul(100).toFixed(1)}%`,
      maxLeverage: config.maxLeverage.toFixed(1),
      rebalanceHours: config.rebalanceIntervalMs / 3600000,
      assets: config.targetAssets,
    },
    period: {
      start: result.startDate.toISOString(),
      end: result.endDate.toISOString(),
    },
    performance: {
      totalReturn: `${result.totalReturn.mul(100).toFixed(2)}%`,
      annualizedReturn: `${result.annualizedReturn.mul(100).toFixed(2)}%`,
      maxDrawdown: `${result.maxDrawdown.toFixed(2)}%`,
      sharpeRatio: result.sharpeRatio.toFixed(2),
      totalFundingCollected: `$${result.totalFundingCollected.toFixed(2)}`,
      totalLendingCollected: `$${result.totalLendingCollected.toFixed(2)}`,
      winRate: `${result.winRate.mul(100).toFixed(1)}%`,
      totalPeriods: result.totalTrades,
      directionFlips: result.directionFlips,
    },
    assetBreakdown: Object.fromEntries(
      config.targetAssets.map((asset) => {
        const s = result.assetBreakdown?.[asset];
        return [
          asset,
          {
            fundingCollected: s ? `$${s.fundingCollected.toFixed(2)}` : "$0.00",
            lendingCollected: s ? `$${s.lendingCollected.toFixed(2)}` : "$0.00",
            periodsActive: s?.periodsActive ?? 0,
            winRate: s && s.periodsActive > 0
              ? `${((s.periodsPositive / s.periodsActive) * 100).toFixed(1)}%`
              : "0.0%",
          },
        ];
      })
    ),
    equityCurve: result.dailyReturns.map((d) => ({
      date: d.date.toISOString().split("T")[0],
      return: d.return.toFixed(6),
    })),
  };

  const filename = `backtest_results_${mode}_${result.startDate.toISOString().split("T")[0]}_${result.endDate.toISOString().split("T")[0]}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${filename}`);
}

main().catch(console.error);
