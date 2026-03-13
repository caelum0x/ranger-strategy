import Decimal from "decimal.js";

export interface Position {
  asset: string;
  side: "long" | "short";
  venue: "drift" | "binance";
  size: Decimal;
  entryPrice: Decimal;
  currentPrice: Decimal;
  notionalValue: Decimal;
  unrealizedPnl: Decimal;
  leverage: Decimal;
  healthRatio: Decimal;
  timestamp: number;
}

export interface FundingRate {
  asset: string;
  venue: string;
  rate: Decimal;
  annualizedRate: Decimal;
  timestamp: number;
  nextSettlement: number;
}

export interface StrategyState {
  totalCapital: Decimal;
  deployedCapital: Decimal;
  idleCapital: Decimal;
  positions: Position[];
  totalPnl: Decimal;
  totalFundingCollected: Decimal;
  totalLendingCollected: Decimal;
  totalTradingCosts: Decimal;
  currentDrawdown: Decimal;
  maxDrawdownHit: Decimal;
  healthRatio: Decimal;
  apyEstimate: Decimal;
  lastRebalance: number;
  regime: MarketRegime;
  cycleCount: number;
  directionFlips: number;
}

export type MarketRegime = "bull" | "bear" | "neutral" | "volatile";

export interface TradeSignal {
  asset: string;
  action: "open" | "close" | "increase" | "decrease" | "rebalance";
  spotVenue: "drift";
  perpVenue: "binance" | "drift";
  /** Direction for the spot leg (long = buy, short = borrow-sell) */
  spotSide: "long" | "short";
  /** Direction for the perp leg */
  perpSide: "long" | "short";
  spotSize: Decimal;
  perpSize: Decimal;
  confidence: Decimal;
  reason: string;
  predictedFundingRate: Decimal;
}

export interface RiskCheck {
  passed: boolean;
  healthRatio: Decimal;
  drawdown: Decimal;
  leverage: Decimal;
  violations: string[];
}

export interface BacktestResult {
  startDate: Date;
  endDate: Date;
  totalReturn: Decimal;
  annualizedReturn: Decimal;
  maxDrawdown: Decimal;
  sharpeRatio: Decimal;
  totalFundingCollected: Decimal;
  totalLendingCollected: Decimal;
  totalTrades: number;
  winRate: Decimal;
  directionFlips: number;
  dailyReturns: { date: Date; return: Decimal }[];
}
