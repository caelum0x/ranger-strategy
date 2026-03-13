/**
 * Drift funding rate analysis module.
 * Uses calculations from drift-labs/protocol-v2/sdk/src/math/funding.ts
 */
import {
  DriftClient,
  convertToNumber,
  PRICE_PRECISION,
  FUNDING_RATE_PRECISION,
  BN,
  PerpMarketAccount,
} from "@drift-labs/sdk";
import Decimal from "decimal.js";
import { config } from "../config";
import { FundingRate } from "../strategy/types";
import { logger } from "../utils/logger";

// Re-use the drift math for live funding rate estimation
// These functions mirror protocol-v2/sdk/src/math/funding.ts
const FUNDING_RATE_BUFFER = FUNDING_RATE_PRECISION.div(new BN(3));

export interface FundingAnalysis {
  asset: string;
  currentRate: Decimal;
  annualizedRate: Decimal;
  last24hAvgRate: Decimal;
  predictedDirection: "positive" | "negative" | "neutral";
  confidence: Decimal;
  markTwap: Decimal;
  oracleTwap: Decimal;
  premium: Decimal; // mark - oracle as percentage
  longShortImbalance: Decimal;
  isAttractive: boolean; // profitable for either direction
  /** Which perp side to take: "short" if funding positive, "long" if negative */
  attractiveDirection: "short" | "long" | null;
  /** Funding rate momentum: rising, falling, or flat */
  momentum: "rising" | "falling" | "flat";
  /** EMA-based momentum score (-1 to 1) */
  momentumScore: Decimal;
}

export class DriftFundingAnalyzer {
  private client: DriftClient;
  private historicalRates: Map<string, FundingRate[]> = new Map();

  constructor(client: DriftClient) {
    this.client = client;
  }

  /**
   * Analyze funding rate for a specific perp market.
   * Uses on-chain data from the PerpMarketAccount.
   */
  analyzeFundingRate(
    asset: string,
    marketIndex: number
  ): FundingAnalysis | null {
    const perpMarket = this.client.getPerpMarketAccount(marketIndex);
    if (!perpMarket) return null;

    const amm = perpMarket.amm;

    // Current hourly funding rate
    const lastRate = convertToNumber(
      amm.lastFundingRate,
      FUNDING_RATE_PRECISION
    );

    // 24h average funding rate (stored on-chain)
    const avg24h = convertToNumber(
      amm.last24HAvgFundingRate,
      FUNDING_RATE_PRECISION
    );

    // Mark and oracle TWAPs
    const markTwap = convertToNumber(
      amm.lastMarkPriceTwap,
      PRICE_PRECISION
    );
    const oracleTwap = convertToNumber(
      amm.historicalOracleData.lastOraclePriceTwap,
      PRICE_PRECISION
    );

    // Premium: (mark - oracle) / oracle
    const premium = oracleTwap !== 0 ? (markTwap - oracleTwap) / oracleTwap : 0;

    // Long/short imbalance from AMM
    const baseAssetAmountLong = convertToNumber(
      amm.baseAssetAmountLong,
      new BN(1e9)
    );
    const baseAssetAmountShort = convertToNumber(
      amm.baseAssetAmountShort,
      new BN(1e9)
    );
    const totalBase = Math.abs(baseAssetAmountLong) + Math.abs(baseAssetAmountShort);
    const imbalance =
      totalBase > 0
        ? (baseAssetAmountLong - Math.abs(baseAssetAmountShort)) / totalBase
        : 0;

    // Annualized: hourly rate * 24 * 365.25
    const annualized = lastRate * 24 * 365.25;
    const avg24hAnnualized = avg24h * 24 * 365.25;

    // Predict direction: positive premium + net long → likely positive funding
    const predictedDirection =
      premium > 0.0005
        ? "positive"
        : premium < -0.0005
          ? "negative"
          : "neutral";

    // Confidence based on consistency of signals
    let confidence = 0.5;
    if (predictedDirection === "positive" && lastRate > 0 && avg24h > 0)
      confidence = 0.85;
    else if (predictedDirection === "negative" && lastRate < 0 && avg24h < 0)
      confidence = 0.85;
    else if (predictedDirection === "neutral")
      confidence = 0.4;
    else confidence = 0.6;

    // Bi-directional attractiveness:
    // Positive funding (shorts collect) → short perp + long spot
    // Negative funding (longs collect)  → long perp + short spot
    // Both are delta-neutral, both collect funding
    const absAnnualized = Math.abs(annualized);
    const isAttractive = absAnnualized > 0.05; // 5% min either direction
    // Determine which direction to take; skip if rate is exactly zero
    const attractiveDirection: "short" | "long" | null =
      !isAttractive || annualized === 0
        ? null
        : annualized > 0
          ? "short"  // positive funding → short perp collects
          : "long";  // negative funding → long perp collects

    // Momentum: compare current rate vs 24h average
    // If current is stronger than average, momentum is in that direction
    const rateDelta = lastRate - avg24h;
    const momentumScore = avg24h !== 0 ? rateDelta / Math.abs(avg24h) : 0;
    const momentum: "rising" | "falling" | "flat" =
      momentumScore > 0.1 ? "rising" : momentumScore < -0.1 ? "falling" : "flat";

    const analysis: FundingAnalysis = {
      asset,
      currentRate: new Decimal(lastRate),
      annualizedRate: new Decimal(annualized),
      last24hAvgRate: new Decimal(avg24hAnnualized),
      predictedDirection,
      confidence: new Decimal(confidence),
      markTwap: new Decimal(markTwap),
      oracleTwap: new Decimal(oracleTwap),
      premium: new Decimal(premium),
      longShortImbalance: new Decimal(imbalance),
      isAttractive,
      attractiveDirection,
      momentum,
      momentumScore: new Decimal(momentumScore),
    };

    logger.info(`Funding analysis for ${asset}`, {
      currentRate: `${(lastRate * 100).toFixed(6)}%/hr`,
      annualized: `${(annualized * 100).toFixed(2)}%`,
      avg24h: `${(avg24hAnnualized * 100).toFixed(2)}%`,
      premium: `${(premium * 100).toFixed(4)}%`,
      imbalance: `${(imbalance * 100).toFixed(2)}%`,
      predicted: predictedDirection,
      confidence: `${(confidence * 100).toFixed(0)}%`,
      attractive: isAttractive,
      direction: attractiveDirection || "none",
      momentum,
      momentumScore: momentumScore.toFixed(3),
    });

    return analysis;
  }

  /**
   * Analyze all target assets and rank by attractiveness for the basis trade.
   */
  analyzeAllAssets(): FundingAnalysis[] {
    const MARKET_INDEX: Record<string, number> = {
      SOL: 0,
      BTC: 1,
      ETH: 2,
    };

    const analyses: FundingAnalysis[] = [];

    for (const asset of config.targetAssets) {
      const marketIndex = MARKET_INDEX[asset];
      if (marketIndex === undefined) continue;

      const analysis = this.analyzeFundingRate(asset, marketIndex);
      if (analysis) {
        analyses.push(analysis);
      }
    }

    // Sort by annualized rate (best for shorts first)
    analyses.sort((a, b) =>
      b.annualizedRate.minus(a.annualizedRate).toNumber()
    );

    return analyses;
  }

  /**
   * Fetch historical funding rates from Drift Data API for backtesting
   * and trend analysis.
   */
  async fetchHistoricalRates(
    asset: string,
    limit: number = 500
  ): Promise<FundingRate[]> {
    const symbol = `${asset}-PERP`;
    const url = `${config.driftDataApi}/market/${symbol}/fundingRates?limit=${limit}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = (await resp.json()) as any[];

      const rates: FundingRate[] = data.map((entry: any) => {
        const rate =
          entry.oraclePriceTwap !== 0
            ? entry.fundingRate / entry.oraclePriceTwap
            : 0;
        return {
          asset,
          venue: "drift" as const,
          rate: new Decimal(rate),
          annualizedRate: new Decimal(rate * 24 * 365.25),
          timestamp: entry.ts * 1000,
          nextSettlement: entry.ts * 1000 + 3600_000,
        };
      });

      this.historicalRates.set(asset, rates);

      logger.info(`Fetched ${rates.length} historical funding rates for ${asset}`, {
        oldest: new Date(rates[rates.length - 1]?.timestamp || 0).toISOString(),
        newest: new Date(rates[0]?.timestamp || 0).toISOString(),
      });

      return rates;
    } catch (err) {
      logger.error(`Failed to fetch historical rates for ${asset}`, {
        error: err,
      });
      return [];
    }
  }

  /**
   * Calculate funding rate trend over recent periods.
   * Returns slope of linear regression over the window.
   */
  calculateTrend(
    rates: FundingRate[],
    windowHours: number = 48
  ): { slope: Decimal; direction: "rising" | "falling" | "flat" } {
    const cutoff = Date.now() - windowHours * 3600_000;
    const recent = rates.filter((r) => r.timestamp >= cutoff);

    if (recent.length < 3) {
      return { slope: new Decimal(0), direction: "flat" };
    }

    // Simple linear regression on annualized rates
    const n = recent.length;
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      const y = recent[i].annualizedRate.toNumber();
      sumY += y;
      sumXY += i * y;
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    const slope =
      denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;

    const direction =
      slope > 0.001 ? "rising" : slope < -0.001 ? "falling" : "flat";

    return { slope: new Decimal(slope), direction };
  }

  /**
   * Estimate funding income for a given position over a time period.
   */
  estimateFundingIncome(
    notionalValue: Decimal,
    annualizedRate: Decimal,
    hoursHeld: number
  ): Decimal {
    // funding per period = notional * rate * (hours / 8760)
    return notionalValue.mul(annualizedRate).mul(hoursHeld).div(8760);
  }

  /**
   * Get average funding rates from Drift Data API.
   */
  async getAverageFundingRates(): Promise<
    Record<string, { avg1h: number; avg24h: number; avg7d: number }>
  > {
    try {
      const resp = await fetch(`${config.driftDataApi}/stats/fundingRates`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (await resp.json()) as any;
    } catch (err) {
      logger.error("Failed to fetch average funding rates", { error: err });
      return {};
    }
  }
}
