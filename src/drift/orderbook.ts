/**
 * DLOB L2 Order Book + Price Impact Estimation.
 *
 * Ported from drift-plugin/tools/drift.ts:
 *   - getL2OrderBook() — fetch L2 from Drift DLOB API
 *   - getEntryQuoteOfPerpTrade() — estimate price impact
 *   - calculatePerpMarketFundingRate() — live funding with TWAP
 *   - getLendingAndBorrowAPY() — spot lending/borrowing rates
 *
 * Used by: strategy engine (pre-trade analysis), filler bot, floating maker.
 */
import {
  DriftClient,
  BN,
  BASE_PRECISION,
  PRICE_PRECISION,
  QUOTE_PRECISION,
  PERCENTAGE_PRECISION,
  FUNDING_RATE_BUFFER_PRECISION,
  PositionDirection,
  MainnetPerpMarkets,
  MainnetSpotMarkets,
  convertToNumber,
  numberToSafeBN,
  calculateEstimatedEntryPriceWithL2,
  calculateLongShortFundingRateAndLiveTwaps,
  calculateDepositRate,
  calculateInterestRate,
  BigNum,
} from "@drift-labs/sdk";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

interface RawL2Level {
  price: string;
  size: string;
  sources: Record<string, string>;
}

interface RawL2Output {
  bids: RawL2Level[];
  asks: RawL2Level[];
  slot: number;
  oracleData: {
    price?: string;
    slot?: string;
    confidence?: string;
    hasSufficientNumberOfDataPoints?: boolean;
    twap?: string;
    twapConfidence?: string;
    maxPrice?: string;
  };
}

export interface L2OrderBook {
  bids: Array<{ price: BN; size: BN; sources: Record<string, BN> }>;
  asks: Array<{ price: BN; size: BN; sources: Record<string, BN> }>;
  oracleData: {
    price?: BN;
    slot?: BN;
    confidence?: BN;
    hasSufficientNumberOfDataPoints?: boolean;
    twap?: BN;
    twapConfidence?: BN;
    maxPrice?: BN;
  };
  slot: number;
}

export interface EntryQuote {
  entryPrice: number;
  priceImpact: number;
  bestPrice: number;
  worstPrice: number;
}

export interface FundingRateInfo {
  longRate: number;
  shortRate: number;
  friendlyString: string;
}

export interface LendBorrowAPY {
  lendingAPY: number;
  borrowAPY: number;
}

// ── DLOB API Base URL ───────────────────────────────────────────

const DLOB_API = "https://dlob.drift.trade";

// ── Functions (ported from drift-plugin) ────────────────────────

/**
 * Fetch L2 order book from Drift's DLOB API.
 * From: drift-plugin/tools/drift.ts → getL2OrderBook()
 */
export async function getL2OrderBook(
  marketSymbol: string
): Promise<L2OrderBook> {
  const symbol = marketSymbol.toUpperCase().endsWith("-PERP")
    ? marketSymbol.toUpperCase()
    : `${marketSymbol.toUpperCase()}-PERP`;

  const response = await fetch(
    `${DLOB_API}/l2?marketName=${symbol}&includeOracle=true`
  );
  if (!response.ok) {
    throw new Error(`DLOB L2 fetch failed: ${response.status}`);
  }

  const raw = (((await response.json()) as any)) as RawL2Output;

  const parseSources = (sources: Record<string, string>) =>
    Object.entries(sources).reduce(
      (acc, [key, val]) => ({ ...acc, [key]: new BN(val) }),
      {} as Record<string, BN>
    );

  return {
    bids: raw.bids.map((b) => ({
      price: new BN(b.price),
      size: new BN(b.size),
      sources: parseSources(b.sources),
    })),
    asks: raw.asks.map((a) => ({
      price: new BN(a.price),
      size: new BN(a.size),
      sources: parseSources(a.sources),
    })),
    oracleData: {
      price: raw.oracleData.price ? new BN(raw.oracleData.price) : undefined,
      slot: raw.oracleData.slot ? new BN(raw.oracleData.slot) : undefined,
      confidence: raw.oracleData.confidence
        ? new BN(raw.oracleData.confidence)
        : undefined,
      hasSufficientNumberOfDataPoints:
        raw.oracleData.hasSufficientNumberOfDataPoints,
      twap: raw.oracleData.twap ? new BN(raw.oracleData.twap) : undefined,
      twapConfidence: raw.oracleData.twapConfidence
        ? new BN(raw.oracleData.twapConfidence)
        : undefined,
      maxPrice: raw.oracleData.maxPrice
        ? new BN(raw.oracleData.maxPrice)
        : undefined,
    },
    slot: raw.slot,
  };
}

/**
 * Estimate entry price + price impact for a perp trade using L2 data.
 * From: drift-plugin/tools/drift.ts → getEntryQuoteOfPerpTrade()
 */
export async function getEntryQuoteOfPerpTrade(
  marketSymbol: string,
  amount: number,
  direction: "long" | "short"
): Promise<EntryQuote> {
  const l2 = await getL2OrderBook(marketSymbol);
  const result = calculateEstimatedEntryPriceWithL2(
    "quote",
    numberToSafeBN(amount, BASE_PRECISION),
    direction === "long" ? PositionDirection.LONG : PositionDirection.SHORT,
    BASE_PRECISION,
    l2 as any
  );

  return {
    entryPrice: convertToNumber(result.entryPrice, QUOTE_PRECISION),
    priceImpact: convertToNumber(result.priceImpact, QUOTE_PRECISION),
    bestPrice: convertToNumber(result.bestPrice, QUOTE_PRECISION),
    worstPrice: convertToNumber(result.worstPrice, QUOTE_PRECISION),
  };
}

/**
 * Calculate live funding rates using on-chain TWAP data.
 * From: drift-plugin/tools/drift.ts → calculatePerpMarketFundingRate()
 */
export async function calculatePerpMarketFundingRate(
  client: DriftClient,
  marketIndex: number,
  period: "hour" | "year" = "hour"
): Promise<FundingRateInfo> {
  const marketAccount = client.getPerpMarketAccount(marketIndex);
  if (!marketAccount) throw new Error(`Market ${marketIndex} not found`);

  const oracleData = client.getOracleDataForPerpMarket(marketIndex) as any;
  const [, , longFundingRate, shortFundingRate] =
    await calculateLongShortFundingRateAndLiveTwaps(
      marketAccount,
      oracleData,
      undefined,
      new BN(Date.now())
    );

  const FUNDING_RATE_PRECISION_EXP = new BN(10).pow(new BN(9));
  let longRate = BigNum.from(
    longFundingRate.mul(FUNDING_RATE_BUFFER_PRECISION),
    FUNDING_RATE_PRECISION_EXP
  ).toNum();
  let shortRate = BigNum.from(
    shortFundingRate.mul(FUNDING_RATE_BUFFER_PRECISION),
    FUNDING_RATE_PRECISION_EXP
  ).toNum();

  if (period === "year") {
    const paymentsPerYear = 24 * 365.25;
    longRate *= paymentsPerYear;
    shortRate *= paymentsPerYear;
  }

  const longsArePaying = longRate > 0;
  const shortsArePaying = !(shortRate > 0);
  const unit = period === "year" ? "% APR" : "%";
  const friendlyString = `Longs ${longsArePaying ? "pay" : "receive"} ${Math.abs(longRate).toFixed(period === "hour" ? 5 : 2)}${unit}, Shorts ${shortsArePaying ? "pay" : "receive"} ${Math.abs(shortRate).toFixed(period === "hour" ? 5 : 2)}${unit}`;

  return {
    longRate: longsArePaying ? -Math.abs(longRate) : Math.abs(longRate),
    shortRate: shortsArePaying ? -Math.abs(shortRate) : Math.abs(shortRate),
    friendlyString,
  };
}

/**
 * Get lending and borrowing APY for a spot token.
 * From: drift-plugin/tools/drift.ts → getLendingAndBorrowAPY()
 */
export function getLendingAndBorrowAPY(
  client: DriftClient,
  symbol: string
): LendBorrowAPY {
  const token = MainnetSpotMarkets.find(
    (v) => v.symbol === symbol.toUpperCase()
  );
  if (!token) {
    throw new Error(`Spot market ${symbol} not found`);
  }

  const marketAccount = client.getSpotMarketAccount(token.marketIndex);
  if (!marketAccount) throw new Error(`Spot market account not found`);

  const lendAPY = calculateDepositRate(marketAccount);
  const borrowAPY = calculateInterestRate(marketAccount);

  return {
    lendingAPY: convertToNumber(lendAPY, PERCENTAGE_PRECISION) * 100,
    borrowAPY: convertToNumber(borrowAPY, PERCENTAGE_PRECISION) * 100,
  };
}
