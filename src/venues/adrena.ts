/**
 * Adrena Protocol integration — another perp venue for cross-venue intelligence.
 *
 * Ported from adrena-plugin. Adrena is a Solana perp DEX with its own
 * funding rates. Comparing Drift vs Adrena vs Flash funding rates
 * helps find the best venue for each leg of delta-neutral.
 *
 * NOTE: Execution goes through Ranger SOR (which routes to Adrena automatically).
 * This module provides DATA for cross-venue decisions.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";

export interface AdrenaMarketInfo {
  symbol: string;
  side: "long" | "short";
  fundingRate: number;
  borrowRate: number;
  openInterest: number;
  maxLeverage: number;
}

export interface AdrenaPosition {
  symbol: string;
  side: "long" | "short";
  size: number;
  collateral: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  leverage: number;
}

// Adrena program ID (from adrena-plugin)
const ADRENA_PROGRAM_ID = new PublicKey(
  "13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet"
);

export class AdrenaClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Get Adrena market info including funding/borrow rates.
   * Used for cross-venue funding rate comparison.
   */
  async getMarkets(): Promise<AdrenaMarketInfo[]> {
    try {
      // Adrena exposes market data via their API
      const response = await fetch("https://datapi.adrena.xyz/v2/markets");
      if (!response.ok) return [];
      const data = (await response.json()) as any;
      return (data.markets || data || []).map((m: any) => ({
        symbol: m.symbol || m.name || "",
        side: m.side || "long",
        fundingRate: m.fundingRate || m.funding_rate || 0,
        borrowRate: m.borrowRate || m.borrow_rate || 0,
        openInterest: m.openInterest || m.open_interest || 0,
        maxLeverage: m.maxLeverage || m.max_leverage || 10,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get funding rate for a specific market on Adrena.
   */
  async getFundingRate(symbol: string): Promise<number | null> {
    const markets = await this.getMarkets();
    const market = markets.find(
      (m) => m.symbol.toUpperCase().includes(symbol.toUpperCase())
    );
    return market?.fundingRate ?? null;
  }

  /**
   * Get all funding rates for cross-venue comparison.
   * Compare Drift vs Flash vs Adrena to find optimal venue.
   */
  async getAllFundingRates(): Promise<Map<string, number>> {
    const rates = new Map<string, number>();
    const markets = await this.getMarkets();
    for (const m of markets) {
      if (m.symbol && m.fundingRate !== undefined) {
        rates.set(m.symbol.toUpperCase(), m.fundingRate);
      }
    }
    return rates;
  }
}
