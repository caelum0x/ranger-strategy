/**
 * Drift Data API client.
 * Endpoints: https://data.api.drift.trade
 * OpenAPI spec: https://data.api.drift.trade/playground/json
 */
import Decimal from "decimal.js";
import { config } from "../config";
import { logger } from "../utils/logger";

const BASE_URL = config.driftDataApi;

export interface FundingRateEntry {
  ts: number;
  fundingRate: number;
  fundingRateLong: number;
  fundingRateShort: number;
  oraclePriceTwap: number;
  markPriceTwap: number;
  periodRevenue: number;
  baseAssetAmountWithAmm: number;
  cumulativeFundingRateLong: number;
  cumulativeFundingRateShort: number;
}

export interface MarketStats {
  marketIndex: number;
  symbol: string;
  oraclePrice: number;
  markPrice: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  fundingRate24h: number;
}

export interface BorrowRateEntry {
  ts: number;
  rate: number;
  balance: number;
}

export interface CandleEntry {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeEntry {
  ts: number;
  recordId: number;
  userAuthority: string;
  marketIndex: number;
  marketType: string;
  direction: string;
  baseAssetAmount: number;
  quoteAssetAmount: number;
  oraclePrice: number;
  fee: number;
  takerOrderId: number;
  makerOrderId: number;
  actionExplanation: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Drift Data API error: ${resp.status} ${resp.statusText} for ${path}`);
  }
  return resp.json() as Promise<T>;
}

export class DriftDataAPI {
  // ── Funding Rates ────────────────────────────────────────────────

  /**
   * Get paginated funding rates for a market.
   * Returns 20-750 records.
   */
  async getFundingRates(
    symbol: string,
    limit: number = 100
  ): Promise<FundingRateEntry[]> {
    return fetchJson(`/market/${symbol}/fundingRates?limit=${limit}`);
  }

  /**
   * Get historical funding rates for a specific date.
   */
  async getFundingRatesByDate(
    symbol: string,
    year: number,
    month: number,
    day: number
  ): Promise<FundingRateEntry[]> {
    return fetchJson(
      `/market/${symbol}/fundingRates/${year}/${month}/${day}`
    );
  }

  /**
   * Get average funding rates across all markets and time periods.
   */
  async getAverageFundingRates(): Promise<any> {
    return fetchJson("/stats/fundingRates");
  }

  // ── Market Data ──────────────────────────────────────────────────

  /**
   * Get all market stats: prices, volumes, funding rates, OI.
   */
  async getMarketStats(): Promise<MarketStats[]> {
    return fetchJson("/stats/markets");
  }

  /**
   * Get rolling volume for a time interval.
   */
  async getMarketVolume(
    interval: "1h" | "24h" | "30d" = "24h"
  ): Promise<any> {
    return fetchJson(`/stats/markets/volume/${interval}`);
  }

  /**
   * Get 24h price changes.
   */
  async getMarketPrices(): Promise<any> {
    return fetchJson("/stats/markets/prices");
  }

  /**
   * Get OHLC candles for a market.
   * Resolutions: 1, 5, 15, 60, 240, D, W, M
   */
  async getCandles(
    symbol: string,
    resolution: string = "60",
    limit: number = 100
  ): Promise<CandleEntry[]> {
    return fetchJson(
      `/market/${symbol}/candles/${resolution}?limit=${limit}`
    );
  }

  /**
   * Get recent trades for a market.
   */
  async getTrades(
    symbol: string,
    limit: number = 50
  ): Promise<TradeEntry[]> {
    return fetchJson(`/market/${symbol}/trades?limit=${limit}`);
  }

  // ── Borrow/Lend Rates ────────────────────────────────────────────

  /**
   * Get borrow rate history for a spot asset.
   */
  async getBorrowRateHistory(
    symbol: string,
    limit: number = 100
  ): Promise<BorrowRateEntry[]> {
    return fetchJson(
      `/stats/${symbol}/rateHistory/borrow?limit=${limit}`
    );
  }

  /**
   * Get deposit (supply) rate history for a spot asset.
   */
  async getDepositRateHistory(
    symbol: string,
    limit: number = 100
  ): Promise<BorrowRateEntry[]> {
    return fetchJson(
      `/stats/${symbol}/rateHistory/deposit?limit=${limit}`
    );
  }

  // ── AMM Data ─────────────────────────────────────────────────────

  /**
   * Get AMM inventory/position.
   */
  async getAmmPosition(): Promise<any> {
    return fetchJson("/amm/position");
  }

  /**
   * Get AMM bid/ask spreads.
   */
  async getAmmBidAsk(): Promise<any> {
    return fetchJson("/amm/bidAskPrice");
  }

  /**
   * Get oracle prices from AMM.
   */
  async getAmmOraclePrice(): Promise<any> {
    return fetchJson("/amm/oraclePrice");
  }

  /**
   * Get open interest data.
   */
  async getOpenInterest(): Promise<any> {
    return fetchJson("/amm/openInterest");
  }

  // ── User/Authority Data ──────────────────────────────────────────

  /**
   * Get overview snapshots for a wallet authority.
   */
  async getAuthorityOverview(
    authorityId: string,
    days: number = 7
  ): Promise<any> {
    return fetchJson(
      `/authority/${authorityId}/snapshots/overview?days=${days}`
    );
  }

  /**
   * Get trading snapshots for a wallet authority.
   */
  async getAuthorityTradingSnapshots(authorityId: string): Promise<any> {
    return fetchJson(`/authority/${authorityId}/snapshots/trading`);
  }

  // ── Vault Data ───────────────────────────────────────────────────

  /**
   * Get all vault data and metrics from Drift.
   */
  async getVaultStats(): Promise<any> {
    return fetchJson("/stats/vaults");
  }

  // ── Convenience Methods ──────────────────────────────────────────

  /**
   * Get current funding rate as annualized percentage for an asset.
   */
  async getCurrentFundingAPY(asset: string): Promise<Decimal> {
    const symbol = `${asset}-PERP`;
    const rates = await this.getFundingRates(symbol, 1);
    if (rates.length === 0) return new Decimal(0);

    const entry = rates[0];
    const rate =
      entry.oraclePriceTwap !== 0
        ? entry.fundingRate / entry.oraclePriceTwap
        : 0;

    return new Decimal(rate * 24 * 365.25);
  }

  /**
   * Check if funding rate is profitable for short basis trade.
   * Returns true if annualized funding > threshold.
   */
  async isFundingProfitable(
    asset: string,
    minAnnualizedRate: number = 0.05
  ): Promise<boolean> {
    const apy = await this.getCurrentFundingAPY(asset);
    return apy.gt(minAnnualizedRate);
  }

  /**
   * Get the spread between funding rate and borrow rate.
   * This is the net yield of the basis trade.
   */
  async getFundingBorrowSpread(asset: string): Promise<Decimal> {
    const [fundingAPY, borrowHistory] = await Promise.all([
      this.getCurrentFundingAPY(asset),
      this.getBorrowRateHistory(asset, 1),
    ]);

    const borrowRate =
      borrowHistory.length > 0
        ? new Decimal(borrowHistory[0].rate)
        : new Decimal(0);

    return fundingAPY.sub(borrowRate);
  }
}
