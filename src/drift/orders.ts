/**
 * Drift order helpers and delta-neutral execution.
 *
 * Order flow on Drift:
 * 1. JIT auction — market makers compete to fill at better prices
 * 2. DLOB — resting limit orders matched by keeper bots
 * 3. AMM — backstop liquidity (always available)
 *
 * Uses helpers from @drift-labs/sdk: getMarketOrderParams, getLimitOrderParams,
 * getTriggerMarketOrderParams, getOrderParams
 */
import {
  OrderType,
  MarketType,
  PositionDirection,
  PostOnlyParams,
  OrderTriggerCondition,
  BN,
  PRICE_PRECISION,
  BASE_PRECISION,
  getMarketOrderParams,
  getLimitOrderParams,
  getTriggerMarketOrderParams,
  getOrderParams,
  DriftClient,
  convertToNumber,
} from "@drift-labs/sdk";
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

// Market indices
const PERP_INDEX: Record<string, number> = { SOL: 0, BTC: 1, ETH: 2 };
const SPOT_INDEX: Record<string, number> = {
  USDC: 0,
  SOL: 1,
  BTC: 2,
  ETH: 3,
};

// ── Order Builders ─────────────────────────────────────────────────

/**
 * Create a market order for a perp.
 * Goes through JIT auction → DLOB → AMM.
 */
export function createPerpMarketOrder(
  asset: string,
  direction: "long" | "short",
  baseAmount: Decimal
) {
  const marketIndex = PERP_INDEX[asset];
  if (marketIndex === undefined) throw new Error(`Unknown perp: ${asset}`);

  return getMarketOrderParams({
    marketIndex,
    marketType: MarketType.PERP,
    direction:
      direction === "long" ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
  });
}

/**
 * Create a limit order for a perp.
 * Rests on the DLOB at specified price until filled or canceled.
 *
 * PostOnly options:
 * - MUST_POST_ONLY: tx fails if order would cross spread
 * - TRY_POST_ONLY:  order silently skipped if it would cross
 * - SLIDE:          price adjusted one tick inside spread to guarantee maker
 */
export function createPerpLimitOrder(
  asset: string,
  direction: "long" | "short",
  baseAmount: Decimal,
  price: Decimal,
  postOnly: "must" | "try" | "slide" | "none" = "must"
) {
  const marketIndex = PERP_INDEX[asset];
  if (marketIndex === undefined) throw new Error(`Unknown perp: ${asset}`);

  const postOnlyParam = {
    must: PostOnlyParams.MUST_POST_ONLY,
    try: PostOnlyParams.TRY_POST_ONLY,
    slide: PostOnlyParams.SLIDE,
    none: PostOnlyParams.NONE,
  }[postOnly];

  return getLimitOrderParams({
    marketIndex,
    marketType: MarketType.PERP,
    direction:
      direction === "long" ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
    price: new BN(price.mul(1e6).toFixed(0)),
    postOnly: postOnlyParam,
  });
}

/**
 * Create a spot market order.
 */
export function createSpotMarketOrder(
  asset: string,
  direction: "long" | "short",
  baseAmount: Decimal
) {
  const marketIndex = SPOT_INDEX[asset];
  if (marketIndex === undefined) throw new Error(`Unknown spot: ${asset}`);

  return getMarketOrderParams({
    marketIndex,
    marketType: MarketType.SPOT,
    direction:
      direction === "long" ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
  });
}

/**
 * Create a generic order using getOrderParams (works for all order types).
 */
export function createGenericOrder(params: {
  orderType: "market" | "limit" | "oracle" | "trigger_market" | "trigger_limit";
  market: "perp" | "spot";
  asset: string;
  direction: "long" | "short";
  baseAmount: Decimal;
  price?: Decimal;
  triggerPrice?: Decimal;
  triggerCondition?: "above" | "below";
  oraclePriceOffset?: Decimal;
  reduceOnly?: boolean;
}) {
  const indexMap = params.market === "perp" ? PERP_INDEX : SPOT_INDEX;
  const marketIndex = indexMap[params.asset];
  if (marketIndex === undefined)
    throw new Error(`Unknown ${params.market}: ${params.asset}`);

  const orderTypeMap = {
    market: OrderType.MARKET,
    limit: OrderType.LIMIT,
    oracle: OrderType.ORACLE,
    trigger_market: OrderType.TRIGGER_MARKET,
    trigger_limit: OrderType.TRIGGER_LIMIT,
  };

  return getOrderParams({
    orderType: orderTypeMap[params.orderType],
    marketType:
      params.market === "perp" ? MarketType.PERP : MarketType.SPOT,
    marketIndex,
    direction:
      params.direction === "long"
        ? PositionDirection.LONG
        : PositionDirection.SHORT,
    baseAssetAmount: new BN(params.baseAmount.mul(1e9).toFixed(0)),
    price: params.price
      ? new BN(params.price.mul(1e6).toFixed(0))
      : undefined,
    triggerPrice: params.triggerPrice
      ? new BN(params.triggerPrice.mul(1e6).toFixed(0))
      : undefined,
    triggerCondition:
      params.triggerCondition === "above"
        ? OrderTriggerCondition.ABOVE
        : params.triggerCondition === "below"
          ? OrderTriggerCondition.BELOW
          : undefined,
    oraclePriceOffset: params.oraclePriceOffset
      ? params.oraclePriceOffset.mul(1e6).toNumber()
      : undefined,
    reduceOnly: params.reduceOnly,
  });
}

/**
 * Create a stop-loss trigger order.
 * - For a SHORT position: triggers when price goes ABOVE (buy to close)
 * - For a LONG position: triggers when price goes BELOW (sell to close)
 */
export function createStopLossOrder(
  asset: string,
  positionSide: "long" | "short",
  baseAmount: Decimal,
  triggerPrice: Decimal
) {
  const marketIndex = PERP_INDEX[asset];
  if (marketIndex === undefined) throw new Error(`Unknown perp: ${asset}`);

  // Close direction is opposite of position
  const closeDirection =
    positionSide === "short"
      ? PositionDirection.LONG
      : PositionDirection.SHORT;
  const triggerCondition =
    positionSide === "short"
      ? OrderTriggerCondition.ABOVE
      : OrderTriggerCondition.BELOW;

  return getTriggerMarketOrderParams({
    marketIndex,
    marketType: MarketType.PERP,
    direction: closeDirection,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
    triggerPrice: new BN(triggerPrice.mul(1e6).toFixed(0)),
    triggerCondition,
    reduceOnly: true,
  });
}

/**
 * Create a take-profit trigger order.
 * - For a SHORT position: triggers when price goes BELOW (buy to close at profit)
 * - For a LONG position: triggers when price goes ABOVE (sell to close at profit)
 */
export function createTakeProfitOrder(
  asset: string,
  positionSide: "long" | "short",
  baseAmount: Decimal,
  triggerPrice: Decimal
) {
  const marketIndex = PERP_INDEX[asset];
  if (marketIndex === undefined) throw new Error(`Unknown perp: ${asset}`);

  const closeDirection =
    positionSide === "short"
      ? PositionDirection.LONG
      : PositionDirection.SHORT;
  // Take-profit is opposite trigger direction from stop-loss
  const triggerCondition =
    positionSide === "short"
      ? OrderTriggerCondition.BELOW
      : OrderTriggerCondition.ABOVE;

  return getTriggerMarketOrderParams({
    marketIndex,
    marketType: MarketType.PERP,
    direction: closeDirection,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
    triggerPrice: new BN(triggerPrice.mul(1e6).toFixed(0)),
    triggerCondition,
    reduceOnly: true,
  });
}

// ── Delta-Neutral Execution ────────────────────────────────────────

/**
 * Execute delta-neutral entry: buy spot + short perp atomically.
 * Both orders placed in a single tx via placeOrders().
 */
export async function executeDeltaNeutralEntry(
  client: DriftClient,
  asset: string,
  usdcAmount: Decimal
): Promise<void> {
  const perpIdx = PERP_INDEX[asset];
  const spotIdx = SPOT_INDEX[asset];
  if (perpIdx === undefined || spotIdx === undefined) {
    throw new Error(`Unknown asset: ${asset}`);
  }

  // Get oracle price to calculate base amount
  const oracleData = client.getOracleDataForPerpMarket(perpIdx);
  const price = convertToNumber(oracleData.price, PRICE_PRECISION);
  const baseAmount = new Decimal(usdcAmount.toNumber() / price);

  logger.info(
    `Delta-neutral entry: ${asset} | $${usdcAmount.toFixed(2)} | ${baseAmount.toFixed(6)} base @ $${price.toFixed(2)}`
  );

  // Buy spot (long leg)
  const spotOrder = getMarketOrderParams({
    marketIndex: spotIdx,
    marketType: MarketType.SPOT,
    direction: PositionDirection.LONG,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
  });

  // Short perp (hedge leg — matching notional)
  const perpOrder = getMarketOrderParams({
    marketIndex: perpIdx,
    marketType: MarketType.PERP,
    direction: PositionDirection.SHORT,
    baseAssetAmount: client.convertToPerpPrecision(
      parseFloat(baseAmount.toFixed(9))
    ),
  });

  // Place both atomically
  await client.placeOrders([spotOrder, perpOrder] as any);

  logger.info(`Delta-neutral entry executed for ${asset}`);
}

/**
 * Execute delta-neutral exit: close perp + sell spot atomically.
 */
export async function executeDeltaNeutralExit(
  client: DriftClient,
  asset: string
): Promise<void> {
  const perpIdx = PERP_INDEX[asset];
  const spotIdx = SPOT_INDEX[asset];
  if (perpIdx === undefined || spotIdx === undefined) {
    throw new Error(`Unknown asset: ${asset}`);
  }

  const user = client.getUser();

  // Build orders to close both legs
  const orders: any[] = [];

  // Close perp
  const perpPos = user.getPerpPosition(perpIdx);
  if (perpPos && !perpPos.baseAssetAmount.isZero()) {
    const direction = perpPos.baseAssetAmount.isNeg()
      ? PositionDirection.LONG
      : PositionDirection.SHORT;

    orders.push(
      getMarketOrderParams({
        marketIndex: perpIdx,
        marketType: MarketType.PERP,
        direction,
        baseAssetAmount: perpPos.baseAssetAmount.abs(),
        reduceOnly: true,
      })
    );
  }

  // Sell spot
  const spotTokenAmount = user.getTokenAmount(spotIdx);
  const spotAmount = Math.abs(
    convertToNumber(spotTokenAmount, BASE_PRECISION)
  );

  if (spotAmount > 0.0001) {
    orders.push(
      getMarketOrderParams({
        marketIndex: spotIdx,
        marketType: MarketType.SPOT,
        direction: PositionDirection.SHORT,
        baseAssetAmount: new BN(
          new Decimal(spotAmount).mul(1e9).toFixed(0)
        ),
      })
    );
  }

  if (orders.length > 0) {
    await client.placeOrders(orders as any);
    logger.info(`Delta-neutral exit executed for ${asset}`);
  } else {
    logger.info(`No ${asset} positions to close`);
  }
}

/**
 * Place a delta-neutral entry with stop-loss protection.
 * 3 orders in one tx: buy spot + short perp + stop-loss trigger.
 */
export async function executeDeltaNeutralEntryWithStopLoss(
  client: DriftClient,
  asset: string,
  usdcAmount: Decimal,
  stopLossPct: Decimal // e.g. 0.03 = 3% above entry
): Promise<void> {
  const perpIdx = PERP_INDEX[asset];
  const spotIdx = SPOT_INDEX[asset];
  if (perpIdx === undefined || spotIdx === undefined) {
    throw new Error(`Unknown asset: ${asset}`);
  }

  const oracleData = client.getOracleDataForPerpMarket(perpIdx);
  const price = convertToNumber(oracleData.price, PRICE_PRECISION);
  const baseAmount = new Decimal(usdcAmount.toNumber() / price);
  const stopPrice = new Decimal(price).mul(new Decimal(1).add(stopLossPct));

  logger.info(
    `Delta-neutral entry with stop-loss: ${asset} @ $${price.toFixed(2)}, stop @ $${stopPrice.toFixed(2)}`
  );

  const spotOrder = getMarketOrderParams({
    marketIndex: spotIdx,
    marketType: MarketType.SPOT,
    direction: PositionDirection.LONG,
    baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
  });

  const perpOrder = getMarketOrderParams({
    marketIndex: perpIdx,
    marketType: MarketType.PERP,
    direction: PositionDirection.SHORT,
    baseAssetAmount: client.convertToPerpPrecision(
      parseFloat(baseAmount.toFixed(9))
    ),
  });

  // Stop-loss: if price goes above stopPrice, close the short
  const stopLoss = getTriggerMarketOrderParams({
    marketIndex: perpIdx,
    marketType: MarketType.PERP,
    direction: PositionDirection.LONG, // buy to close short
    baseAssetAmount: client.convertToPerpPrecision(
      parseFloat(baseAmount.toFixed(9))
    ),
    triggerPrice: new BN(stopPrice.mul(1e6).toFixed(0)),
    triggerCondition: OrderTriggerCondition.ABOVE,
    reduceOnly: true,
  });

  await client.placeOrders([spotOrder, perpOrder, stopLoss] as any);

  logger.info(
    `Delta-neutral entry with stop-loss executed for ${asset}`
  );
}
