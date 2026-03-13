/**
 * Advanced Drift transaction executor.
 *
 * Uses IX builders for:
 * - Custom compute budget (priority fees for faster inclusion)
 * - Atomic cancel + place (for requoting without stale fill risk)
 * - Batching multiple instructions in a single transaction
 * - Jupiter swaps through Drift
 */
import {
  DriftClient,
  MarketType,
  PositionDirection,
  OrderType,
  getOrderParams,
  getMarketOrderParams,
  BN,
  PRICE_PRECISION,
  convertToNumber,
} from "@drift-labs/sdk";
import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

const PERP_INDEX: Record<string, number> = { SOL: 0, BTC: 1, ETH: 2 };
const SPOT_INDEX: Record<string, number> = {
  USDC: 0,
  SOL: 1,
  BTC: 2,
  ETH: 3,
};

export class DriftExecutor {
  private client: DriftClient;
  private defaultPriorityFee: number;

  constructor(client: DriftClient, priorityFeeMicroLamports: number = 50_000) {
    this.client = client;
    this.defaultPriorityFee = priorityFeeMicroLamports;
  }

  // ── Atomic Cancel & Replace ─────────────────────────────────────

  /**
   * Atomically cancel all orders on a market and place new ones.
   * Prevents stale fills between cancel and re-quote.
   */
  async cancelAndPlacePerp(
    asset: string,
    newOrders: Array<{
      direction: "long" | "short";
      baseAmount: Decimal;
      price: Decimal;
    }>
  ): Promise<string> {
    const marketIndex = PERP_INDEX[asset];
    if (marketIndex === undefined)
      throw new Error(`Unknown perp: ${asset}`);

    const orderParams = newOrders.map((o) =>
      getOrderParams({
        orderType: OrderType.LIMIT,
        marketIndex,
        direction:
          o.direction === "long"
            ? PositionDirection.LONG
            : PositionDirection.SHORT,
        baseAssetAmount: this.client.convertToPerpPrecision(
          parseFloat(o.baseAmount.toFixed(9))
        ),
        price: new BN(o.price.mul(1e6).toFixed(0)),
      })
    );

    logger.info(
      `Atomic cancel+place: ${asset} | ${newOrders.length} orders`
    );

    const txSig = await this.client.cancelAndPlaceOrders(
      { marketType: MarketType.PERP, marketIndex },
      orderParams as any
    );

    return typeof txSig === "string" ? txSig : "";
  }

  // ── Priority Fee Transactions ───────────────────────────────────

  /**
   * Place a perp order with custom compute budget and priority fee.
   * Higher priority fees → faster block inclusion.
   */
  async placePerpOrderWithPriority(
    asset: string,
    direction: "long" | "short",
    baseAmount: Decimal,
    price?: Decimal,
    priorityFee?: number
  ): Promise<string> {
    const marketIndex = PERP_INDEX[asset];
    if (marketIndex === undefined)
      throw new Error(`Unknown perp: ${asset}`);

    const fee = priorityFee || this.defaultPriorityFee;

    // Build the order IX
    const orderParams = price
      ? getOrderParams({
          orderType: OrderType.LIMIT,
          marketIndex,
          direction:
            direction === "long"
              ? PositionDirection.LONG
              : PositionDirection.SHORT,
          baseAssetAmount: this.client.convertToPerpPrecision(
            parseFloat(baseAmount.toFixed(9))
          ),
          price: new BN(price.mul(1e6).toFixed(0)),
        })
      : getMarketOrderParams({
          marketIndex,
          marketType: MarketType.PERP,
          direction:
            direction === "long"
              ? PositionDirection.LONG
              : PositionDirection.SHORT,
          baseAssetAmount: this.client.convertToPerpPrecision(
            parseFloat(baseAmount.toFixed(9))
          ),
        });

    const placeIx = await this.client.getPlacePerpOrderIx(orderParams);

    // Compute budget IXs
    const computePrice = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: fee,
    });
    const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    // Build versioned tx
    const tx = await (this.client.txSender as any).getVersionedTransaction(
      [computeLimit, computePrice, placeIx],
      [],
      this.client.wallet.publicKey
    );

    const { txSig } = await (this.client.txSender as any).sendVersionedTransaction(
      tx,
      [],
      this.client.opts
    );

    logger.info(`Placed ${direction} ${asset} perp with priority fee`, {
      txSig,
      priorityFee: fee,
    });

    return txSig;
  }

  // ── Batched IX Execution ────────────────────────────────────────

  /**
   * Execute multiple instructions atomically in a single transaction
   * with compute budget control.
   */
  async executeBatchedIxs(
    instructions: TransactionInstruction[],
    priorityFee?: number,
    computeUnits: number = 400_000
  ): Promise<string> {
    const fee = priorityFee || this.defaultPriorityFee;

    const computePrice = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: fee,
    });
    const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    });

    const allIxs = [computeLimit, computePrice, ...instructions];

    const tx = await (this.client.txSender as any).getVersionedTransaction(
      allIxs,
      [],
      this.client.wallet.publicKey
    );

    const { txSig } = await (this.client.txSender as any).sendVersionedTransaction(
      tx,
      [],
      this.client.opts
    );

    logger.info(`Batched tx executed: ${instructions.length} instructions`, {
      txSig,
    });

    return txSig;
  }

  /**
   * Build an atomic cancel-all + delta-neutral-entry transaction.
   * Cancel any existing orders, then place spot buy + perp short.
   */
  async atomicCancelAndEnterDeltaNeutral(
    asset: string,
    usdcAmount: Decimal
  ): Promise<string> {
    const perpIdx = PERP_INDEX[asset];
    const spotIdx = SPOT_INDEX[asset];
    if (perpIdx === undefined || spotIdx === undefined)
      throw new Error(`Unknown asset: ${asset}`);

    const oracleData = this.client.getOracleDataForPerpMarket(perpIdx);
    const price = convertToNumber(oracleData.price, PRICE_PRECISION);
    const baseAmount = new Decimal(usdcAmount.toNumber() / price);

    // Cancel all existing orders
    const cancelIx = await this.client.getCancelOrdersIx(null, null, null);

    // Buy spot
    const buySpotIx = await this.client.getPlaceSpotOrderIx(
      getMarketOrderParams({
        marketIndex: spotIdx,
        marketType: MarketType.SPOT,
        direction: PositionDirection.LONG,
        baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
      })
    );

    // Short perp
    const shortPerpIx = await this.client.getPlacePerpOrderIx(
      getMarketOrderParams({
        marketIndex: perpIdx,
        marketType: MarketType.PERP,
        direction: PositionDirection.SHORT,
        baseAssetAmount: this.client.convertToPerpPrecision(
          parseFloat(baseAmount.toFixed(9))
        ),
      })
    );

    logger.info(
      `Atomic cancel+enter: ${asset} | $${usdcAmount.toFixed(2)} | ${baseAmount.toFixed(6)} base`
    );

    return this.executeBatchedIxs([cancelIx, buySpotIx, shortPerpIx]);
  }

  // ── Jupiter Swap ────────────────────────────────────────────────

  /**
   * Swap tokens through Jupiter via Drift.
   * Useful for converting USDC → SOL for spot leg.
   */
  async jupiterSwap(
    fromAsset: string,
    toAsset: string,
    amount: Decimal,
    slippageBps: number = 50
  ): Promise<string> {
    const inMarketIndex = SPOT_INDEX[fromAsset];
    const outMarketIndex = SPOT_INDEX[toAsset];
    if (inMarketIndex === undefined || outMarketIndex === undefined) {
      throw new Error(`Unknown asset: ${fromAsset} or ${toAsset}`);
    }

    // Determine precision based on asset (USDC = 1e6, SOL = 1e9)
    const precision = fromAsset === "USDC" ? 1e6 : 1e9;

    logger.info(
      `Jupiter swap: ${amount.toFixed(4)} ${fromAsset} → ${toAsset} (${slippageBps}bps slippage)`
    );

    const ix = await (this.client as any).getJupiterSwapIxV6({
      inMarketIndex,
      outMarketIndex,
      amount: new BN(amount.mul(precision).toFixed(0)),
      slippageBps,
    });

    return this.executeBatchedIxs([ix]);
  }

  // ── Cancel Helpers ──────────────────────────────────────────────

  /**
   * Cancel all orders across all markets.
   */
  async cancelAllOrders(): Promise<void> {
    logger.info("Canceling all orders");
    await (this.client as any).cancelOrders(null, null, null);
  }

  /**
   * Cancel all perp orders for a specific asset.
   */
  async cancelPerpOrders(asset: string): Promise<void> {
    const marketIndex = PERP_INDEX[asset];
    if (marketIndex === undefined)
      throw new Error(`Unknown perp: ${asset}`);

    logger.info(`Canceling all ${asset} perp orders`);
    await (this.client as any).cancelOrders(MarketType.PERP, marketIndex, null);
  }

  /**
   * Cancel specific orders by ID.
   */
  async cancelOrdersByIds(orderIds: number[]): Promise<void> {
    logger.info(`Canceling orders: ${orderIds.join(", ")}`);
    await this.client.cancelOrdersByIds(orderIds);
  }

  // ── Settle PnL ──────────────────────────────────────────────────

  /**
   * Settle PnL for the current user across perp markets.
   */
  async settlePnl(marketIndices: number[]): Promise<void> {
    const user = this.client.getUser();

    const ixs = await this.client.getSettlePNLsIxs(
      [
        {
          settleeUserAccountPublicKey: await this.client.getUserAccountPublicKey(),
          settleeUserAccount: user.getUserAccount(),
        },
      ],
      marketIndices
    );

    if (ixs.length > 0) {
      await this.executeBatchedIxs(ixs);
      logger.info(`Settled PnL for markets: ${marketIndices.join(", ")}`);
    }
  }

  // ── Modify Orders ────────────────────────────────────────────

  /**
   * Modify an existing order's price and/or size.
   * Uses SDK's modifyOrder for in-place updates without cancel+place.
   */
  async modifyOrder(
    orderId: number,
    newPrice?: Decimal,
    newBaseAmount?: Decimal
  ): Promise<void> {
    const modifyParams: any = { orderId };
    if (newPrice) {
      modifyParams.newLimitPrice = new BN(newPrice.mul(1e6).toFixed(0));
    }
    if (newBaseAmount) {
      modifyParams.newBaseAmount = new BN(newBaseAmount.mul(1e9).toFixed(0));
    }

    logger.info(`Modifying order #${orderId}`, modifyParams);
    await this.client.modifyOrder(modifyParams);
  }

  // ── Atomic Delta-Neutral Exit ─────────────────────────────────

  /**
   * Atomically close both legs of a delta-neutral position.
   * Cancel all orders → close perp → sell spot in a single tx.
   */
  async atomicDeltaNeutralExit(asset: string): Promise<string> {
    const perpIdx = PERP_INDEX[asset];
    const spotIdx = SPOT_INDEX[asset];
    if (perpIdx === undefined || spotIdx === undefined)
      throw new Error(`Unknown asset: ${asset}`);

    const user = this.client.getUser();
    const ixs: any[] = [];

    // Cancel all existing orders first
    const cancelIx = await this.client.getCancelOrdersIx(null, null, null);
    ixs.push(cancelIx);

    // Close perp position
    const perpPos = user.getPerpPosition(perpIdx);
    if (perpPos && !perpPos.baseAssetAmount.isZero()) {
      const direction = perpPos.baseAssetAmount.isNeg()
        ? PositionDirection.LONG
        : PositionDirection.SHORT;

      const closePerpIx = await this.client.getPlacePerpOrderIx(
        getMarketOrderParams({
          marketIndex: perpIdx,
          marketType: MarketType.PERP,
          direction,
          baseAssetAmount: perpPos.baseAssetAmount.abs(),
          reduceOnly: true,
        })
      );
      ixs.push(closePerpIx);
    }

    // Sell spot position
    const tokenAmount = user.getTokenAmount(spotIdx);
    const spotAmount = Math.abs(
      convertToNumber(tokenAmount, new BN(1e9))
    );

    if (spotAmount > 0.0001) {
      const sellSpotIx = await this.client.getPlaceSpotOrderIx(
        getMarketOrderParams({
          marketIndex: spotIdx,
          marketType: MarketType.SPOT,
          direction: PositionDirection.SHORT,
          baseAssetAmount: new BN(
            new Decimal(spotAmount).mul(1e9).toFixed(0)
          ),
        })
      );
      ixs.push(sellSpotIx);
    }

    if (ixs.length <= 1) {
      logger.info(`No ${asset} positions to close`);
      return "";
    }

    logger.info(`Atomic delta-neutral exit: ${asset} | ${ixs.length - 1} close IXs`);
    return this.executeBatchedIxs(ixs);
  }
}
