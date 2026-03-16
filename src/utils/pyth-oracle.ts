/**
 * Pyth Oracle price feeds — direct oracle access for price validation.
 *
 * Ported from pyth-plugin/tools/pyth_fetch_price.ts.
 * Uses Pyth Hermes API for real-time price data independent of on-chain oracles.
 * Cross-references with Drift oracle for staleness/divergence detection.
 *
 * Used by: oracle guard, price impact estimation, cross-venue arb.
 */
import { logger } from "./logger";

// ── Types ───────────────────────────────────────────────────────

export interface PythPrice {
  symbol: string;
  feedId: string;
  price: number;
  confidence: number;
  exponent: number;
  publishTime: number;
}

// ── Pyth Hermes API ─────────────────────────────────────────────

const PYTH_HERMES_API = "https://hermes.pyth.network";

/**
 * Fetch price feed ID for a token symbol.
 * From: pyth-plugin/tools/pyth_fetch_price.ts → fetchPythPriceFeedID()
 */
export async function fetchPythFeedId(symbol: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${PYTH_HERMES_API}/v2/price_feeds?query=${symbol}&asset_type=crypto`
    );
    if (!response.ok) return null;

    const feeds = (await response.json()) as any[];
    if (!feeds || feeds.length === 0) return null;

    // Return the first matching feed
    return feeds[0].id;
  } catch {
    return null;
  }
}

/**
 * Fetch latest price for a Pyth feed ID.
 * From: pyth-plugin/tools/pyth_fetch_price.ts → fetchPythPrice()
 */
export async function fetchPythPrice(feedId: string): Promise<PythPrice | null> {
  try {
    const response = await fetch(
      `${PYTH_HERMES_API}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`
    );
    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const parsed = data?.parsed?.[0];
    if (!parsed) return null;

    const priceData = parsed.price;
    const exponent = priceData.expo;
    const price = Number(priceData.price) * Math.pow(10, exponent);
    const confidence = Number(priceData.conf) * Math.pow(10, exponent);

    return {
      symbol: parsed.id?.slice(0, 8) || "",
      feedId,
      price,
      confidence,
      exponent,
      publishTime: parsed.price.publish_time || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch price for a token symbol (convenience wrapper).
 * Resolves feed ID then fetches price.
 */
export async function fetchPriceBySymbol(
  symbol: string
): Promise<PythPrice | null> {
  const feedId = await fetchPythFeedId(symbol);
  if (!feedId) return null;
  return fetchPythPrice(feedId);
}

/**
 * Fetch prices for multiple symbols in parallel.
 * Used for portfolio-wide price validation.
 */
export async function fetchMultiplePrices(
  symbols: string[]
): Promise<Map<string, PythPrice>> {
  const results = new Map<string, PythPrice>();

  const promises = symbols.map(async (symbol) => {
    const price = await fetchPriceBySymbol(symbol);
    if (price) {
      results.set(symbol, price);
    }
  });

  await Promise.all(promises);
  return results;
}

// ── Well-known Pyth feed IDs (mainnet) ──────────────────────────

export const PYTH_FEED_IDS: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  JTO: "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  INJ: "7a5bc1d2b56ad029048cd63964b3ad2776eadf812eef3a1d0d0d7e4ddbba0e1d",
};
