import ccxt, { Exchange } from "ccxt";
import Decimal from "decimal.js";
import { config } from "../config";
import { FundingRate, Position } from "../strategy/types";
import { logger } from "../utils/logger";

const BINANCE_SYMBOLS: Record<string, string> = {
  SOL: "SOL/USDT:USDT",
  BTC: "BTC/USDT:USDT",
  ETH: "ETH/USDT:USDT",
};

export class BinanceManager {
  private exchange!: Exchange;

  async initialize(): Promise<void> {
    this.exchange = new ccxt.binance({
      apiKey: config.binanceApiKey,
      secret: config.binanceSecret,
      options: {
        defaultType: "future",
        adjustForTimeDifference: true,
      },
      sandbox: config.binanceTestnet,
    });

    await this.exchange.loadMarkets();
    logger.info("Binance client initialized", {
      testnet: config.binanceTestnet,
    });
  }

  async getFundingRates(): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];

    for (const asset of config.targetAssets) {
      const symbol = BINANCE_SYMBOLS[asset];
      if (!symbol) continue;

      try {
        const funding = await this.exchange.fetchFundingRate(symbol);

        const rate = new Decimal(funding.fundingRate || 0);
        // Binance funding is every 8h, annualize: rate * 3 * 365.25
        const annualized = rate.mul(3).mul(365.25);

        rates.push({
          asset,
          venue: "binance",
          rate,
          annualizedRate: annualized,
          timestamp: funding.timestamp || Date.now(),
          nextSettlement: funding.fundingDatetime
            ? new Date(funding.fundingDatetime).getTime()
            : Date.now() + 28800000,
        });
      } catch (err) {
        logger.error(`Failed to fetch funding rate for ${asset} on Binance`, {
          error: err,
        });
      }
    }

    return rates;
  }

  async getHistoricalFundingRates(
    asset: string,
    since: number,
    limit: number = 500
  ): Promise<FundingRate[]> {
    const symbol = BINANCE_SYMBOLS[asset];
    if (!symbol) throw new Error(`Unknown asset: ${asset}`);

    const history = await this.exchange.fetchFundingRateHistory(
      symbol,
      since,
      limit
    );

    return history.map((entry) => ({
      asset,
      venue: "binance",
      rate: new Decimal(entry.fundingRate || 0),
      annualizedRate: new Decimal(entry.fundingRate || 0).mul(3).mul(365.25),
      timestamp: entry.timestamp || Date.now(),
      nextSettlement: (entry.timestamp || Date.now()) + 28800000,
    }));
  }

  async shortPerp(asset: string, usdcAmount: Decimal): Promise<void> {
    const symbol = BINANCE_SYMBOLS[asset];
    if (!symbol) throw new Error(`Unknown asset: ${asset}`);

    const ticker = await this.exchange.fetchTicker(symbol);
    const price = new Decimal(ticker.last || 0);
    const amount = usdcAmount.div(price);

    logger.info(`Shorting ${amount.toFixed(6)} ${asset} perp on Binance`, {
      usdcAmount: usdcAmount.toFixed(2),
      price: price.toFixed(2),
    });

    await this.exchange.createOrder(
      symbol,
      "market",
      "sell",
      parseFloat(amount.toFixed(6)),
      undefined,
      { reduceOnly: false }
    );
  }

  async closePerp(asset: string): Promise<void> {
    const symbol = BINANCE_SYMBOLS[asset];
    if (!symbol) throw new Error(`Unknown asset: ${asset}`);

    const positions = await this.exchange.fetchPositions([symbol]);
    const pos = positions.find(
      (p) =>
        p.symbol === symbol.replace(":USDT", "") &&
        parseFloat(p.contracts?.toString() || "0") > 0
    );

    if (!pos || parseFloat(pos.contracts?.toString() || "0") === 0) {
      logger.info(`No ${asset} perp position to close on Binance`);
      return;
    }

    const contracts = Math.abs(parseFloat(pos.contracts?.toString() || "0"));
    const side = pos.side === "short" ? "buy" : "sell";

    logger.info(`Closing ${asset} perp on Binance: ${side} ${contracts}`);

    await this.exchange.createOrder(symbol, "market", side, contracts, undefined, {
      reduceOnly: true,
    });
  }

  async getPositions(): Promise<Position[]> {
    const positions: Position[] = [];

    for (const asset of config.targetAssets) {
      const symbol = BINANCE_SYMBOLS[asset];
      if (!symbol) continue;

      try {
        const binancePositions = await this.exchange.fetchPositions([symbol]);
        for (const pos of binancePositions) {
          const contracts = Math.abs(
            parseFloat(pos.contracts?.toString() || "0")
          );
          if (contracts === 0) continue;

          const entryPrice = parseFloat(
            pos.entryPrice?.toString() || "0"
          );
          const markPrice = parseFloat(
            pos.markPrice?.toString() || "0"
          );
          const notional = parseFloat(
            pos.notional?.toString() || "0"
          );
          const pnl = parseFloat(
            pos.unrealizedPnl?.toString() || "0"
          );

          positions.push({
            asset,
            side: pos.side === "long" ? "long" : "short",
            venue: "binance",
            size: new Decimal(contracts),
            entryPrice: new Decimal(entryPrice),
            currentPrice: new Decimal(markPrice),
            notionalValue: new Decimal(Math.abs(notional)),
            unrealizedPnl: new Decimal(pnl),
            leverage: new Decimal(
              parseFloat(pos.leverage?.toString() || "1")
            ),
            healthRatio: new Decimal(
              parseFloat(pos.marginRatio?.toString() || "999")
            ),
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        logger.error(`Failed to fetch ${asset} position from Binance`, {
          error: err,
        });
      }
    }

    return positions;
  }

  async getBalance(): Promise<Decimal> {
    const balance = await this.exchange.fetchBalance();
    const usdt = balance["USDT"]?.total || 0;
    return new Decimal(usdt);
  }

  async setLeverage(asset: string, leverage: number): Promise<void> {
    const symbol = BINANCE_SYMBOLS[asset];
    if (!symbol) return;

    await this.exchange.setLeverage(leverage, symbol);
    logger.info(`Set ${asset} leverage to ${leverage}x on Binance`);
  }

  async exportTradeHistory(
    startTime: number,
    endTime: number
  ): Promise<object[]> {
    const allTrades: object[] = [];

    for (const asset of config.targetAssets) {
      const symbol = BINANCE_SYMBOLS[asset];
      if (!symbol) continue;

      const trades = await this.exchange.fetchMyTrades(symbol, startTime, 1000);
      allTrades.push(
        ...trades.map((t) => ({
          asset,
          symbol: t.symbol,
          side: t.side,
          amount: t.amount,
          price: t.price,
          cost: t.cost,
          fee: t.fee,
          timestamp: t.timestamp,
          datetime: t.datetime,
        }))
      );
    }

    return allTrades.sort(
      (a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0)
    );
  }

  async shutdown(): Promise<void> {
    logger.info("Binance client shut down");
  }
}
