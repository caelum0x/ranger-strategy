import Decimal from "decimal.js";
import * as fs from "fs";
import { BinanceManager } from "../binance/client";
import { BacktestResult, FundingRate } from "../strategy/types";
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
}

interface DailySnapshot {
  date: Date;
  equity: Decimal;
  fundingIncome: Decimal;
  tradingCosts: Decimal;
  positions: { asset: string; fundingRate: Decimal }[];
}

export async function runBacktest(
  cfg: BacktestConfig
): Promise<BacktestResult> {
  logger.info("Starting backtest", {
    startDate: cfg.startDate.toISOString(),
    endDate: cfg.endDate.toISOString(),
    initialCapital: cfg.initialCapital.toFixed(2),
    assets: cfg.assets,
  });

  // Fetch historical funding rates from Binance
  const binance = new BinanceManager();
  await binance.initialize();

  const allRates: Record<string, FundingRate[]> = {};
  for (const asset of cfg.assets) {
    allRates[asset] = await binance.getHistoricalFundingRates(
      asset,
      cfg.startDate.getTime(),
      1000
    );
    logger.info(`Fetched ${allRates[asset].length} funding rates for ${asset}`);
  }

  // Simulate strategy
  let equity = cfg.initialCapital;
  let peakEquity = equity;
  let maxDrawdown = new Decimal(0);
  let totalFunding = new Decimal(0);
  let totalTrades = 0;
  let wins = 0;
  const dailyReturns: { date: Date; return: Decimal }[] = [];

  // Group funding rates into 8h periods
  const startTs = cfg.startDate.getTime();
  const endTs = cfg.endDate.getTime();
  const periodMs = 8 * 3600 * 1000; // 8 hours

  let prevEquity = equity;

  for (let ts = startTs; ts < endTs; ts += periodMs) {
    // Get funding rates for this period
    let periodFunding = new Decimal(0);
    let activeAssets = 0;

    for (const asset of cfg.assets) {
      const rates = allRates[asset];
      const rate = rates.find(
        (r) => r.timestamp >= ts && r.timestamp < ts + periodMs
      );

      if (rate && rate.rate.gt(new Decimal(0))) {
        // Positive funding — we collect as shorts
        const positionSize = equity.div(cfg.assets.length);
        const fundingPayment = positionSize.mul(rate.rate);
        periodFunding = periodFunding.add(fundingPayment);
        activeAssets++;
      }
    }

    // Subtract trading costs (0.04% taker fee per rebalance, amortized)
    const rebalanceCost = equity.mul(new Decimal("0.0004")).div(
      new Decimal(cfg.rebalanceHours).div(8)
    );

    const netIncome = periodFunding.sub(rebalanceCost);
    equity = equity.add(netIncome);
    totalFunding = totalFunding.add(periodFunding);

    if (periodFunding.gt(0)) {
      wins++;
    }
    totalTrades++;

    // Track drawdown
    if (equity.gt(peakEquity)) {
      peakEquity = equity;
    }
    const drawdown = peakEquity.sub(equity).div(peakEquity).mul(100);
    if (drawdown.gt(maxDrawdown)) {
      maxDrawdown = drawdown;
    }

    // Circuit breaker
    if (drawdown.gt(cfg.maxDrawdownPct)) {
      logger.warn(
        `Backtest circuit breaker hit at ${new Date(ts).toISOString()}`
      );
      // Would close positions, but in backtest just stop counting
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
  }

  // Calculate results
  const totalDays = (endTs - startTs) / (86400 * 1000);
  const totalReturn = equity.sub(cfg.initialCapital).div(cfg.initialCapital);
  const annualizedReturn = totalReturn.mul(new Decimal(365.25).div(totalDays));

  // Sharpe ratio (simplified)
  const avgDailyReturn = dailyReturns.reduce(
    (sum, d) => sum.add(d.return),
    new Decimal(0)
  ).div(dailyReturns.length || 1);

  const dailyVariance = dailyReturns.reduce(
    (sum, d) => sum.add(d.return.sub(avgDailyReturn).pow(2)),
    new Decimal(0)
  ).div(dailyReturns.length || 1);

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
    totalTrades,
    winRate: totalTrades > 0 ? new Decimal(wins).div(totalTrades) : new Decimal(0),
    dailyReturns,
  };

  logger.info("Backtest complete", {
    totalReturn: `${totalReturn.mul(100).toFixed(2)}%`,
    annualizedReturn: `${annualizedReturn.mul(100).toFixed(2)}%`,
    maxDrawdown: `${maxDrawdown.toFixed(2)}%`,
    sharpeRatio: sharpeRatio.toFixed(2),
    totalFundingCollected: `$${totalFunding.toFixed(2)}`,
    winRate: `${result.winRate.mul(100).toFixed(1)}%`,
  });

  return result;
}

// Entry point
async function main() {
  const result = await runBacktest({
    startDate: new Date("2025-09-01"),
    endDate: new Date("2026-03-09"),
    initialCapital: new Decimal(10000), // Backtest with larger capital for meaningful results
    assets: config.targetAssets,
    maxLeverage: config.maxLeverage,
    maxDrawdownPct: config.maxDrawdownPct,
    rebalanceHours: config.rebalanceIntervalMs / 3600000,
  });

  console.log("\n=== BACKTEST RESULTS ===");
  console.log(`Period: ${result.startDate.toDateString()} → ${result.endDate.toDateString()}`);
  console.log(`Total Return: ${result.totalReturn.mul(100).toFixed(2)}%`);
  console.log(`Annualized Return: ${result.annualizedReturn.mul(100).toFixed(2)}%`);
  console.log(`Max Drawdown: ${result.maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
  console.log(`Total Funding Collected: $${result.totalFundingCollected.toFixed(2)}`);
  console.log(`Win Rate: ${result.winRate.mul(100).toFixed(1)}%`);
  console.log(`Total Periods: ${result.totalTrades}`);

  // Save results to JSON for submission
  const output = {
    strategy: "USDC Delta-Neutral Funding Harvester",
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
      winRate: `${result.winRate.mul(100).toFixed(1)}%`,
      totalPeriods: result.totalTrades,
    },
    equityCurve: result.dailyReturns.map((d) => ({
      date: d.date.toISOString().split("T")[0],
      return: d.return.toFixed(6),
    })),
  };

  const filename = `backtest_results_${result.startDate.toISOString().split("T")[0]}_${result.endDate.toISOString().split("T")[0]}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${filename}`);
}

main().catch(console.error);
