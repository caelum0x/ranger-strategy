/**
 * Ranger Data API client — market intelligence for strategy decisions.
 *
 * Ported from solana-agent-kit/packages/plugin-defi/src/ranger/actions/*.
 * Provides access to Ranger's aggregated market data:
 *   - Funding rate arbitrage opportunities across venues
 *   - Liquidation data (latest, heatmap, capitulation signals)
 *   - Accumulated funding/borrow rates by symbol
 *   - OI-weighted funding rates
 *   - Trade history
 *
 * These endpoints are critical for our strategy engine:
 *   - Funding arbs → cross-venue strategy signal
 *   - Liquidation data → risk management + liquidation bot
 *   - Accumulated rates → backtest validation
 */
import { logger } from "../utils/logger";
import { config } from "../config";

// ── API Config ──────────────────────────────────────────────────

const DATA_API_BASE =
  process.env.RANGER_DATA_API_BASE ||
  "https://data-api-staging-437363704888.asia-northeast1.run.app";

const API_KEY = process.env.RANGER_API_KEY || "";

// ── Types ───────────────────────────────────────────────────────

export interface FundingRateArb {
  symbol: string;
  long_venue: string;
  short_venue: string;
  long_rate: number;
  short_rate: number;
  diff: number;
  annualized_diff: number;
}

export interface LiquidationEvent {
  symbol: string;
  side: string;
  size: number;
  price: number;
  venue: string;
  timestamp: string;
}

export interface FundingRateAccumulated {
  symbol: string;
  platform: string;
  rate: number;
  accumulated: number;
  period: string;
}

export interface FundingRateTrend {
  symbol: string;
  platform: string;
  timestamps: string[];
  rates: number[];
}

export interface LiquidationHeatmap {
  symbol: string;
  data: Array<{
    price: number;
    volume: number;
    timestamp: string;
  }>;
}

export interface TradeHistoryEntry {
  symbol: string;
  side: string;
  size: number;
  price: number;
  venue: string;
  timestamp: string;
  pnl?: number;
}

// ── Client ──────────────────────────────────────────────────────

export class RangerDataApi {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || DATA_API_BASE;
    this.apiKey = apiKey || API_KEY;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await fetch(url.toString(), { method: "GET", headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText })) as any;
      throw new Error(`Ranger Data API ${path} failed: ${error.message}`);
    }
    return response.json() as Promise<T>;
  }

  // ── Funding Rate Endpoints ──────────────────────────────────

  /**
   * Get funding rate arbitrage opportunities across venues.
   * Critical for cross-venue strategy — find where to long/short.
   *
   * From: ranger/actions/getFundingRateArbs.ts
   */
  async getFundingRateArbs(minDiff?: number): Promise<FundingRateArb[]> {
    const params: Record<string, string> = {};
    if (minDiff !== undefined) params.min_diff = minDiff.toString();

    const data = await this.get<any>("/v1/funding_rates/arbs", params);
    return data.arbs || data;
  }

  /**
   * Get accumulated funding rates by symbol and platform.
   * From: ranger/actions/getFundingRatesAccumulated.ts
   */
  async getFundingRatesAccumulated(
    symbol?: string,
    platform?: string,
    period?: string
  ): Promise<FundingRateAccumulated[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (platform) params.platform = platform;
    if (period) params.period = period;

    return this.get("/v1/funding_rates/accumulated", params);
  }

  /**
   * Get extreme funding rate events (outliers).
   * From: ranger/actions/getFundingRatesExtreme.ts
   */
  async getFundingRatesExtreme(
    symbol?: string,
    platform?: string,
    period?: string
  ): Promise<any> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (platform) params.platform = platform;
    if (period) params.period = period;

    return this.get("/v1/funding_rates/extreme", params);
  }

  /**
   * Get OI-weighted funding rates.
   * From: ranger/actions/getFundingRatesOiWeighted.ts
   */
  async getFundingRatesOiWeighted(): Promise<any> {
    return this.get("/v1/funding_rates/oi_weighted");
  }

  /**
   * Get funding rate trend for a market.
   * From: ranger/actions/getFundingRatesTrend.ts
   */
  async getFundingRatesTrend(
    symbol?: string,
    platform?: string,
    period?: string
  ): Promise<FundingRateTrend[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (platform) params.platform = platform;
    if (period) params.period = period;

    return this.get("/v1/funding_rates/trend", params);
  }

  /**
   * Get accumulated borrow rates.
   * From: ranger/actions/getBorrowRatesAccumulated.ts
   */
  async getBorrowRatesAccumulated(
    symbol?: string,
    platform?: string,
    period?: string
  ): Promise<any> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (platform) params.platform = platform;
    if (period) params.period = period;

    return this.get("/v1/borrow_rates/accumulated", params);
  }

  // ── Liquidation Endpoints ───────────────────────────────────

  /**
   * Get latest liquidation events.
   * From: ranger/actions/getLiquidationsLatest.ts
   */
  async getLiquidationsLatest(
    symbol?: string,
    limit?: number
  ): Promise<LiquidationEvent[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (limit) params.limit = limit.toString();

    return this.get("/v1/liquidations/latest", params);
  }

  /**
   * Get aggregated liquidation totals.
   * From: ranger/actions/getLiquidationsTotals.ts
   */
  async getLiquidationsTotals(
    symbol?: string,
    period?: string
  ): Promise<any> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (period) params.period = period;

    return this.get("/v1/liquidations/totals", params);
  }

  /**
   * Get liquidation capitulation signals.
   * From: ranger/actions/getLiquidationsCapitulation.ts
   */
  async getLiquidationsCapitulation(
    symbol?: string,
    granularity?: string,
    threshold?: number
  ): Promise<any> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (granularity) params.granularity = granularity;
    if (threshold) params.threshold = threshold.toString();

    return this.get("/v1/liquidations/capitulation", params);
  }

  /**
   * Get liquidation heatmap data (time-series).
   * From: ranger/actions/getLiquidationsHeatmap.ts
   */
  async getLiquidationsHeatmap(
    symbol?: string,
    granularity?: string
  ): Promise<LiquidationHeatmap[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (granularity) params.granularity = granularity;

    return this.get("/v1/liquidations/heatmap", params);
  }

  /**
   * Get largest liquidation events.
   * From: ranger/actions/getLiquidationsLargest.ts
   */
  async getLiquidationsLargest(
    symbol?: string,
    limit?: number
  ): Promise<LiquidationEvent[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (limit) params.limit = limit.toString();

    return this.get("/v1/liquidations/largest", params);
  }

  // ── Position & Trade Endpoints ──────────────────────────────

  /**
   * Get open positions.
   * From: ranger/actions/getPositions.ts
   */
  async getPositions(
    feePayer: string,
    symbol?: string,
    platform?: string
  ): Promise<any> {
    const params: Record<string, string> = { fee_payer: feePayer };
    if (symbol) params.symbol = symbol;
    if (platform) params.platform = platform;

    return this.get("/v1/positions", params);
  }

  /**
   * Get trade history.
   * From: ranger/actions/getTradeHistory.ts
   */
  async getTradeHistory(
    feePayer: string,
    startTime?: string,
    endTime?: string
  ): Promise<TradeHistoryEntry[]> {
    const params: Record<string, string> = { fee_payer: feePayer };
    if (startTime) params.start_time = startTime;
    if (endTime) params.end_time = endTime;

    return this.get("/v1/trade_history", params);
  }
}
