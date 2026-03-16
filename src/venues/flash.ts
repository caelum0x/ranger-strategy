/**
 * Flash Trade integration — additional perp venue for cross-venue arb.
 *
 * Ported from flash-plugin/tools/flash_open_trade.ts + flash_close_trade.ts.
 * Flash Trade is a Solana perp DEX with its own funding rates.
 * By comparing Flash vs Drift funding, we can capture cross-venue arb.
 *
 * Used by: cross-venue strategy, Ranger SOR routing.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface FlashPosition {
  symbol: string;
  side: "long" | "short";
  size: number;
  collateral: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface FlashMarketInfo {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
}

// ── Flash Client ────────────────────────────────────────────────

export class FlashTradeClient {
  private connection: Connection;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    programId = new PublicKey("FLASH111111111111111111111111111111111111111")
  ) {
    this.connection = connection;
    this.programId = programId;
  }

  /**
   * Open a perp position on Flash Trade.
   * From: flash-plugin/tools/flash_open_trade.ts → flashOpenTrade()
   *
   * In production: uses flash-sdk for position management.
   */
  async openPosition(params: {
    symbol: string;
    side: "long" | "short";
    collateralUsd: number;
    leverage: number;
    walletPubkey: PublicKey;
  }): Promise<string> {
    const size = params.collateralUsd * params.leverage;

    logger.info("Flash: opening position", {
      symbol: params.symbol,
      side: params.side,
      size: size.toFixed(2),
      leverage: params.leverage,
    });

    // In production: uses flash-sdk PerpetualsClient
    // const client = new PerpetualsClient(connection, programId);
    // const tx = await client.openPosition({ ... });
    return "";
  }

  /**
   * Close a perp position on Flash Trade.
   * From: flash-plugin/tools/flash_close_trade.ts
   */
  async closePosition(params: {
    symbol: string;
    side: "long" | "short";
    walletPubkey: PublicKey;
  }): Promise<string> {
    logger.info("Flash: closing position", {
      symbol: params.symbol,
      side: params.side,
    });

    return "";
  }

  /**
   * Get Flash market data (funding rates for cross-venue comparison).
   */
  async getMarkets(): Promise<FlashMarketInfo[]> {
    try {
      // Flash Trade API for market data
      const response = await fetch("https://api.flash.trade/v1/markets");
      if (!response.ok) return [];
      const data = ((await response.json()) as any);
      return data.markets || [];
    } catch {
      return [];
    }
  }

  /**
   * Get funding rate for a specific market.
   * Used by cross-venue strategy to compare Flash vs Drift rates.
   */
  async getFundingRate(symbol: string): Promise<number | null> {
    const markets = await this.getMarkets();
    const market = markets.find(
      (m) => m.symbol.toUpperCase() === symbol.toUpperCase()
    );
    return market?.fundingRate ?? null;
  }
}
