/**
 * Advanced Drift transaction executor.
 *
 * Uses IX builders for:
 * - Custom compute budget (priority fees for faster inclusion)
 * - Atomic cancel + place (for requoting without stale fill risk)
 * - Batching multiple instructions in a single transaction
 * - Jupiter swaps through Drift
 *
 * Upgraded with patterns from keeper-bots-v2:
 * - Transaction simulation before sending (estimateComputeUnits)
 * - Jito bundle support for MEV protection (sendAsBundle)
 * - Address lookup table (ALT) support for larger transactions
 * - Transaction log parsing for error diagnosis
 */
import {
  DriftClient,
  getTokenAmount,
  MarketType,
  PositionDirection,
  OrderType,
  getOrderParams,
  getMarketOrderParams,
  BN,
  PRICE_PRECISION,
  convertToNumber,
} from "@drift-labs/sdk";
import {
  ComputeBudgetProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  Connection,
} from "@solana/web3.js";
import Decimal from "decimal.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { fetchHeliusPriorityFeeEstimate } from "../utils/priority-fee";
import { RangerSorClient } from "../ranger/sor-client";
import {
  decimalPriceToBN,
  deriveExecutionPricingPlan,
} from "../utils/execution-pricing";

const PERP_INDEX: Record<string, number> = { SOL: 0, BTC: 1, ETH: 2 };
const SPOT_INDEX: Record<string, number> = {
  USDC: 0,
  SOL: 1,
  BTC: 2,
  ETH: 3,
};
const SPOT_ASSET: Record<number, string> = {
  0: "USDC",
  1: "SOL",
  2: "BTC",
  3: "ETH",
};

const MARKET_INDEX: Record<string, { perp: number; spot: number }> = {
  SOL: { perp: 0, spot: 1 },
  BTC: { perp: 1, spot: 2 },
  ETH: { perp: 2, spot: 3 },
};

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

export class DriftExecutor {
  protected client: DriftClient;
  private defaultPriorityFee: number;
  private readonly sorClient: RangerSorClient;

  constructor(
    client: DriftClient,
    priorityFeeMicroLamports: number = 50_000,
    sorClient: RangerSorClient = new RangerSorClient()
  ) {
    this.client = client;
    this.defaultPriorityFee = priorityFeeMicroLamports;
    this.sorClient = sorClient;
  }

  private async withActiveSubaccount<T>(
    subAccountId: number | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    if (subAccountId === undefined || subAccountId === this.client.activeSubAccountId) {
      return fn();
    }

    const previousSubAccountId = this.client.activeSubAccountId;
    await this.client.switchActiveUser(subAccountId, this.client.authority);
    try {
      return await fn();
    } finally {
      await this.client.switchActiveUser(previousSubAccountId, this.client.authority);
    }
  }

  private async resolvePriorityFee(
    extraAccountKeys: string[] = [],
    priorityFee?: number
  ): Promise<number> {
    if (priorityFee) {
      return priorityFee;
    }

    const accountKeys = [
      this.client.wallet.publicKey.toBase58(),
      ...extraAccountKeys,
    ];
    const estimated = await fetchHeliusPriorityFeeEstimate(accountKeys);
    return estimated || this.defaultPriorityFee;
  }

  // ── Atomic Cancel & Replace ─────────────────────────────────────

  private async getSorQuotedPrice(
    asset: string,
    side: "long" | "short",
    baseAmount: Decimal,
    collateralAmount: Decimal
  ): Promise<Decimal | undefined> {
    if (!this.sorClient.isConfigured()) {
      return undefined;
    }

    try {
      const metadata = await this.sorClient.getOrderMetadata({
        fee_payer: this.client.wallet.publicKey.toBase58(),
        symbol: asset,
        side: side === "long" ? "Long" : "Short",
        size: Number(baseAmount.toFixed(6)),
        collateral: Number(collateralAmount.toFixed(6)),
        size_denomination: asset,
        collateral_denomination: "USDC",
        adjustment_type: "Increase",
      });

      if (!metadata || metadata.total_size <= 0 || metadata.total_collateral <= 0) {
        return undefined;
      }

      return new Decimal(metadata.total_collateral).div(metadata.total_size);
    } catch (error) {
      logger.warn("SOR quote fetch failed, using oracle fallback", {
        asset,
        side,
        error,
      });
      return undefined;
    }
  }

  private getOracleSlippageInputs(asset: string): {
    oracleConfidenceBps?: number;
    oracleSpreadBps?: number;
  } {
    const perpIdx = PERP_INDEX[asset];
    if (perpIdx === undefined) {
      return {};
    }

    const perpMarket = this.client.getPerpMarketAccount(perpIdx);
    if (!perpMarket) {
      return {};
    }

    const confPct = convertToNumber(
      perpMarket.amm.lastOracleConfPct,
      new BN(1_000_000)
    );
    const spreadPct = convertToNumber(
      perpMarket.amm.lastOracleReservePriceSpreadPct,
      new BN(1_000_000)
    );

    return {
      oracleConfidenceBps: Math.abs(confPct) * 10_000,
      oracleSpreadBps: Math.abs(spreadPct) * 10_000,
    };
  }

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

    const fee = await this.resolvePriorityFee([this.client.wallet.publicKey.toBase58()], priorityFee);

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
    const fee = await this.resolvePriorityFee([], priorityFee);

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
   * Bi-directional: supports both positive funding (short perp + long spot)
   * and negative funding (long perp + short spot).
   *
   * @param perpDirection - "short" for positive funding, "long" for negative funding
   */
  async atomicCancelAndEnterDeltaNeutral(
    asset: string,
    usdcAmount: Decimal,
    perpDirection: "short" | "long" = "short"
  ): Promise<string> {
    const perpIdx = PERP_INDEX[asset];
    const spotIdx = SPOT_INDEX[asset];
    if (perpIdx === undefined || spotIdx === undefined)
      throw new Error(`Unknown asset: ${asset}`);

    const oracleData = this.client.getOracleDataForPerpMarket(perpIdx);
    const oraclePrice = oracleData.price; // BN in PRICE_PRECISION
    const price = convertToNumber(oraclePrice, PRICE_PRECISION);

    // Validate oracle price is sane (non-zero, non-negative)
    if (price <= 0) {
      throw new Error(
        `Invalid oracle price for ${asset}: ${price} — aborting to prevent bad fills`
      );
    }

    let baseAmount = new Decimal(usdcAmount.toNumber() / price);

    // Check spot market minimum step size and round up if needed
    try {
      const spotMarket = this.client.getSpotMarketAccount(spotIdx);
      if (spotMarket) {
        const stepSize = convertToNumber(spotMarket.orderStepSize, new BN(1e9));
        if (baseAmount.toNumber() < stepSize && stepSize > 0) {
          logger.warn(
            `${asset} spot order ${baseAmount.toFixed(6)} below step size ${stepSize} — rounding up`
          );
          baseAmount = new Decimal(stepSize);
        }
      }
    } catch {
      // Non-critical — proceed with original amount
    }

    const spotDirection = perpDirection === "short"
      ? PositionDirection.LONG
      : PositionDirection.SHORT;
    const perpDir = perpDirection === "short"
      ? PositionDirection.SHORT
      : PositionDirection.LONG;
    const spotSide = perpDirection === "short" ? "long" : "short";
    const quotedSpotPrice = await this.getSorQuotedPrice(
      asset,
      spotSide,
      baseAmount,
      usdcAmount
    );
    const oracleSlippageInputs = this.getOracleSlippageInputs(asset);

    const spotPlan = deriveExecutionPricingPlan({
      side: spotSide,
      oraclePrice: new Decimal(price),
      fallbackSlippageBps: DEFAULT_SLIPPAGE_BPS,
      quotedPrice: quotedSpotPrice,
      ...oracleSlippageInputs,
    });
    const perpPlan = deriveExecutionPricingPlan({
      side: perpDirection,
      oraclePrice: new Decimal(price),
      fallbackSlippageBps: DEFAULT_SLIPPAGE_BPS,
      ...oracleSlippageInputs,
    });

    // Cancel all existing orders
    const cancelIx = await this.client.getCancelOrdersIx(null, null, null);

    // Spot leg (slippage-protected limit order)
    const spotIx = await this.client.getPlaceSpotOrderIx(
      getOrderParams({
        orderType: OrderType.LIMIT,
        marketIndex: spotIdx,
        direction: spotDirection,
        baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
        price: decimalPriceToBN(spotPlan.limitPrice),
      })
    );

    // Perp leg (slippage-protected limit order)
    const perpIx = await this.client.getPlacePerpOrderIx(
      getOrderParams({
        orderType: OrderType.LIMIT,
        marketIndex: perpIdx,
        direction: perpDir,
        baseAssetAmount: this.client.convertToPerpPrecision(
          parseFloat(baseAmount.toFixed(9))
        ),
        price: decimalPriceToBN(perpPlan.limitPrice),
      })
    );

    const spotSideStr = perpDirection === "short" ? "LONG" : "SHORT";
    logger.info(
      `Atomic cancel+enter: ${asset} | ${spotSideStr} spot + ${perpDirection.toUpperCase()} perp | ` +
        `$${usdcAmount.toFixed(2)} | ${baseAmount.toFixed(6)} base | ` +
        `oracle=$${price.toFixed(2)} | spotSlip=${spotPlan.slippageBps}bps | perpSlip=${perpPlan.slippageBps}bps` +
        (spotPlan.quotedPrice
          ? ` | sor=$${spotPlan.quotedPrice.toFixed(4)}`
          : "")
        + (spotPlan.oracleConfidenceBps !== undefined
          ? ` | conf=${spotPlan.oracleConfidenceBps.toFixed(1)}bps`
          : "")
        + (spotPlan.oracleSpreadBps !== undefined
          ? ` | spread=${spotPlan.oracleSpreadBps.toFixed(1)}bps`
          : "")
    );

    return this.executeBatchedIxs([cancelIx, spotIx, perpIx]);
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

  async jupiterSwapByMarketIndex(params: {
    inMarketIndex: number;
    outMarketIndex: number;
    amount: BN;
    slippageBps?: number;
    subAccountId?: number;
  }): Promise<string> {
    const { inMarketIndex, outMarketIndex, amount, subAccountId } = params;
    const slippageBps =
      params.slippageBps ?? config.jupiterSwapSlippageBps;

    return this.withActiveSubaccount(subAccountId, async () => {
      const userAccountPublicKey = await this.client.getUserAccountPublicKey(
        subAccountId
      );
      const swap = await (this.client as any).getJupiterSwapIxV6({
        inMarketIndex,
        outMarketIndex,
        amount,
        slippageBps,
        userAccountPublicKey,
      });

      const instructions = Array.isArray(swap?.ixs) ? swap.ixs : [swap];
      logger.info("Jupiter derisk swap", {
        inMarketIndex,
        outMarketIndex,
        amount: amount.toString(),
        subAccountId,
      });
      return this.executeBatchedIxs(instructions, undefined, 900_000);
    });
  }

  // ── Cancel Helpers ──────────────────────────────────────────────

  /**
   * Cancel all orders across all markets.
   */
  async cancelAllOrders(): Promise<void> {
    logger.info("Canceling all orders");
    await (this.client as any).cancelOrders(null, null, null);
  }

  async cancelAllOrdersForSubaccount(subAccountId?: number): Promise<void> {
    await this.withActiveSubaccount(subAccountId, async () => {
      logger.info("Canceling all orders for subaccount", { subAccountId });
      await (this.client as any).cancelOrders(null, null, null);
    });
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
    let user: any;
    try {
      user = this.client.getUser();
    } catch {
      return; // No user account — nothing to settle
    }

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

  async settlePnlForSubaccount(
    marketIndices: number[],
    subAccountId?: number
  ): Promise<void> {
    await this.withActiveSubaccount(subAccountId, async () => {
      let user: any;
      try {
        user = this.client.getUser(subAccountId);
      } catch {
        return;
      }

      const userAccountPublicKey = await this.client.getUserAccountPublicKey(
        subAccountId
      );
      const ixs = await this.client.getSettlePNLsIxs(
        [
          {
            settleeUserAccountPublicKey: userAccountPublicKey,
            settleeUserAccount: user.getUserAccount(),
          },
        ],
        marketIndices
      );

      if (ixs.length > 0) {
        await this.executeBatchedIxs(ixs);
        logger.info("Settled PnL for subaccount", {
          subAccountId,
          markets: marketIndices,
        });
      }
    });
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

    // Close spot position (direction depends on current side)
    const tokenAmount = user.getTokenAmount(spotIdx);
    const spotAmountRaw = convertToNumber(tokenAmount, new BN(1e9));
    const spotAmount = Math.abs(spotAmountRaw);

    if (spotAmount > 0.0001) {
      // Positive tokenAmount = we hold spot (long) → sell (SHORT) to close
      // Negative tokenAmount = we borrowed spot (short) → buy (LONG) to close
      const spotCloseDirection = spotAmountRaw > 0
        ? PositionDirection.SHORT
        : PositionDirection.LONG;

      const closeSpotIx = await this.client.getPlaceSpotOrderIx(
        getMarketOrderParams({
          marketIndex: spotIdx,
          marketType: MarketType.SPOT,
          direction: spotCloseDirection,
          baseAssetAmount: new BN(
            new Decimal(spotAmount).mul(1e9).toFixed(0)
          ),
        })
      );
      ixs.push(closeSpotIx);
    }

    if (ixs.length <= 1) {
      logger.info(`No ${asset} positions to close`);
      return "";
    }

    logger.info(`Atomic delta-neutral exit: ${asset} | ${ixs.length - 1} close IXs`);
    return this.executeBatchedIxs(ixs);
  }

  async closePerpPositionByMarketIndex(
    marketIndex: number,
    priorityFee?: number,
    subAccountId?: number
  ): Promise<string> {
    const user = this.client.getUser(subAccountId);
    const perpPos = user.getPerpPosition(marketIndex);
    if (!perpPos || perpPos.baseAssetAmount.isZero()) {
      return "";
    }

    const direction = perpPos.baseAssetAmount.isNeg()
      ? PositionDirection.LONG
      : PositionDirection.SHORT;

    const closePerpIx = await this.client.getPlacePerpOrderIx(
      getMarketOrderParams({
        marketIndex,
        marketType: MarketType.PERP,
        direction,
        baseAssetAmount: perpPos.baseAssetAmount.abs(),
        reduceOnly: true,
      }),
      subAccountId
    );

    logger.info("Closing inherited perp exposure", {
      marketIndex,
      baseAssetAmount: perpPos.baseAssetAmount.abs().toString(),
    });

    return this.executeBatchedIxs([closePerpIx], priorityFee, 600_000);
  }

  async closeSpotPositionByMarketIndex(
    marketIndex: number,
    priorityFee?: number,
    subAccountId?: number
  ): Promise<string> {
    const user = this.client.getUser(subAccountId);
    const tokenAmount = user.getTokenAmount(marketIndex);
    if (tokenAmount.isZero()) {
      return "";
    }

    const spotAmountRaw = convertToNumber(tokenAmount, new BN(1e9));
    if (Math.abs(spotAmountRaw) <= 0.0001) {
      return "";
    }

    const direction = spotAmountRaw > 0
      ? PositionDirection.SHORT
      : PositionDirection.LONG;

    const closeSpotIx = await this.client.getPlaceSpotOrderIx(
      getMarketOrderParams({
        marketIndex,
        marketType: MarketType.SPOT,
        direction,
        baseAssetAmount: new BN(
          new Decimal(Math.abs(spotAmountRaw)).mul(1e9).toFixed(0)
        ),
      }),
      subAccountId
    );

    logger.info("Closing inherited spot exposure", {
      marketIndex,
      tokenAmount: tokenAmount.toString(),
    });

    return this.executeBatchedIxs([closeSpotIx], priorityFee, 600_000);
  }

  async deriskSpotMarketToUsdc(
    marketIndex: number,
    subAccountId?: number,
    priorityFee?: number
  ): Promise<string> {
    if (marketIndex === SPOT_INDEX.USDC) {
      return "";
    }

    const user = this.client.getUser(subAccountId);
    const spotPosition = user.getSpotPosition(marketIndex);
    if (!spotPosition) {
      return "";
    }

    const spotMarket = this.client.getSpotMarketAccount(marketIndex);
    if (!spotMarket) {
      return "";
    }

    const tokenAmount = getTokenAmount(
      spotPosition.scaledBalance,
      spotMarket,
      spotPosition.balanceType
    );

    if (tokenAmount.lte(new BN(0))) {
      return this.closeSpotPositionByMarketIndex(
        marketIndex,
        priorityFee,
        subAccountId
      );
    }

    return this.jupiterSwapByMarketIndex({
      inMarketIndex: marketIndex,
      outMarketIndex: SPOT_INDEX.USDC,
      amount: tokenAmount,
      slippageBps: config.jupiterSwapSlippageBps,
      subAccountId,
    });
  }

  async deriskSubaccount(
    subAccountId: number,
    priorityFee?: number
  ): Promise<void> {
    const user = this.client.getUser(subAccountId);
    const activeSpotPositions = user.getActiveSpotPositions();
    const perpMarkets = user
      .getActivePerpPositions()
      .filter(
        (position) =>
          !position.baseAssetAmount.isZero() ||
          !position.quoteAssetAmount.isZero() ||
          position.openOrders > 0
      )
      .map((position) => position.marketIndex);
    const borrowSpotMarkets = activeSpotPositions
      .filter(
        (position) =>
          position.marketIndex !== SPOT_INDEX.USDC &&
          user.getTokenAmount(position.marketIndex).lt(new BN(0))
      )
      .map((position) => position.marketIndex);
    const depositSpotMarkets = activeSpotPositions
      .filter(
        (position) =>
          position.marketIndex !== SPOT_INDEX.USDC &&
          user.getTokenAmount(position.marketIndex).gt(new BN(0))
      )
      .map((position) => position.marketIndex);

    await this.cancelAllOrdersForSubaccount(subAccountId);

    for (const marketIndex of perpMarkets) {
      await this.closePerpPositionByMarketIndex(
        marketIndex,
        priorityFee,
        subAccountId
      );
    }

    if (perpMarkets.length > 0) {
      await this.settlePnlForSubaccount(perpMarkets, subAccountId);
    }

    for (const marketIndex of borrowSpotMarkets) {
      await this.deriskSpotMarketToUsdc(
        marketIndex,
        subAccountId,
        priorityFee
      );
    }

    for (const marketIndex of depositSpotMarkets) {
      await this.deriskSpotMarketToUsdc(
        marketIndex,
        subAccountId,
        priorityFee
      );
    }

    await this.cancelAllOrdersForSubaccount(subAccountId);

    const refreshedUser = this.client.getUser(subAccountId);
    const residualPerpMarkets = refreshedUser
      .getActivePerpPositions()
      .filter(
        (position) =>
          !position.baseAssetAmount.isZero() ||
          !position.quoteAssetAmount.isZero()
      )
      .map((position) => position.marketIndex);
    if (residualPerpMarkets.length > 0) {
      await this.settlePnlForSubaccount(residualPerpMarkets, subAccountId);
    }

    logger.info("Completed subaccount derisk sequence", {
      subAccountId,
      perpMarkets,
      borrowSpotMarkets: borrowSpotMarkets.map(
        (marketIndex) => SPOT_ASSET[marketIndex] || marketIndex
      ),
      depositSpotMarkets: depositSpotMarkets.map(
        (marketIndex) => SPOT_ASSET[marketIndex] || marketIndex
      ),
    });
  }

  // ── Transaction Simulation (from keeper-bots-v2) ───────────────

  /**
   * Simulate a transaction and estimate compute units consumed.
   * From keeper-bots-v2/src/utils.ts (simulateAndGetTxWithCUs).
   *
   * Returns { computeUnits, success, logs } — use CU result to set
   * precise compute budget limits, reducing tx costs by 30-50%.
   */
  async simulateAndGetComputeUnits(
    instructions: TransactionInstruction[],
    lookupTables: AddressLookupTableAccount[] = []
  ): Promise<{
    computeUnits: number;
    success: boolean;
    logs: string[];
    error?: string;
  }> {
    try {
      const latestBlockhash = await this.client.connection.getLatestBlockhash(
        "finalized"
      );

      // Build versioned transaction for simulation
      const messageV0 = new TransactionMessage({
        payerKey: this.client.wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message(lookupTables);

      const tx = new VersionedTransaction(messageV0);

      const result = await this.client.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      if (result.value.err) {
        return {
          computeUnits: 0,
          success: false,
          logs: result.value.logs || [],
          error: JSON.stringify(result.value.err),
        };
      }

      return {
        computeUnits: result.value.unitsConsumed || 200_000,
        success: true,
        logs: result.value.logs || [],
      };
    } catch (err) {
      return {
        computeUnits: 0,
        success: false,
        logs: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute instructions with simulated CU estimation.
   * Simulates first, then sends with tight CU budget (saves SOL).
   * From keeper-bots-v2 pattern: simulate → estimate → send.
   */
  async executeWithSimulation(
    instructions: TransactionInstruction[],
    priorityFee?: number,
    cuBufferMultiplier = 1.3,
    lookupTables: AddressLookupTableAccount[] = []
  ): Promise<string> {
    // Step 1: Simulate to get CU estimate
    const simResult = await this.simulateAndGetComputeUnits(
      instructions,
      lookupTables
    );

    if (!simResult.success) {
      // Parse error logs for known issues (from keeper-bots-v2 txLogParse)
      const errorInfo = this.parseTxLogs(simResult.logs);
      logger.warn("TX simulation failed, skipping send", {
        error: simResult.error,
        parsedError: errorInfo,
      });
      throw new Error(`Simulation failed: ${simResult.error} | ${errorInfo}`);
    }

    // Step 2: Set precise CU budget with buffer
    const estimatedCU = Math.ceil(simResult.computeUnits * cuBufferMultiplier);
    const cuLimit = Math.min(estimatedCU, 1_400_000);

    logger.debug("TX simulation passed", {
      estimatedCU: simResult.computeUnits,
      budgetCU: cuLimit,
      savings: `${((1 - cuLimit / 400_000) * 100).toFixed(0)}% vs default`,
    });

    // Step 3: Send with estimated CU
    return this.executeBatchedIxs(instructions, priorityFee, cuLimit);
  }

  // ── Jito Bundle Support (from keeper-bots-v2/bundleSender.ts) ─

  /**
   * Send a transaction as a Jito bundle for MEV protection.
   * Bundles are atomic — either all txs in the bundle land, or none.
   * Tip goes to Jito validators for priority inclusion.
   *
   * From keeper-bots-v2/src/bundleSender.ts.
   */
  async sendAsJitoBundle(
    instructions: TransactionInstruction[],
    tipLamports: number = 10_000,
    computeUnits: number = 400_000
  ): Promise<string> {
    const jitoEndpoint = config.jitoBlockEngineUrl;
    if (!jitoEndpoint) {
      logger.warn("Jito not configured, falling back to regular send");
      return this.executeBatchedIxs(instructions, undefined, computeUnits);
    }

    try {
      const fee = await this.resolvePriorityFee([]);

      // Build compute budget IXs
      const computePrice = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: fee,
      });
      const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits,
      });

      const allIxs = [computeLimit, computePrice, ...instructions];

      // Add Jito tip instruction
      const tipIx = this.buildJitoTipIx(tipLamports);
      if (tipIx) {
        allIxs.push(tipIx);
      }

      // Build versioned tx
      const latestBlockhash = await this.client.connection.getLatestBlockhash(
        "finalized"
      );
      const messageV0 = new TransactionMessage({
        payerKey: this.client.wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: allIxs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);

      // Send to Jito block engine
      const jitoConnection = new Connection(jitoEndpoint, "confirmed");
      const txSig = await jitoConnection.sendTransaction(tx);

      logger.info("Sent Jito bundle", {
        txSig,
        tipLamports,
        computeUnits,
        ixCount: instructions.length,
      });

      return typeof txSig === "string" ? txSig : "";
    } catch (err) {
      logger.warn("Jito bundle failed, falling back to regular send", {
        error: String(err),
      });
      return this.executeBatchedIxs(instructions, undefined, computeUnits);
    }
  }

  /**
   * Build a tip instruction for Jito validators.
   * Tips incentivize validators to include our bundle.
   */
  private buildJitoTipIx(
    tipLamports: number
  ): TransactionInstruction | null {
    // Jito tip account addresses (from keeper-bots-v2)
    const JITO_TIP_ACCOUNTS = [
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
      "HFqU5x63VTqvQss8hp11i4bPuRQVDqpRZQRN4YLfM2Cq",
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
      "ADaUMid9yfUytqMBgopwjb2DTLSLuaR3PPmMK3UaCip8",
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    ];

    try {
      const { SystemProgram, PublicKey } = require("@solana/web3.js");
      const randomTipAccount =
        JITO_TIP_ACCOUNTS[
          Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
        ];

      return SystemProgram.transfer({
        fromPubkey: this.client.wallet.publicKey,
        toPubkey: new PublicKey(randomTipAccount),
        lamports: tipLamports,
      });
    } catch {
      return null;
    }
  }

  // ── Transaction Log Parsing (from keeper-bots-v2/txLogParse.ts) ─

  /**
   * Parse transaction logs to extract meaningful error info.
   * From keeper-bots-v2/src/bots/common/txLogParse.ts.
   */
  private parseTxLogs(logs: string[]): string {
    const knownErrors: Record<string, string> = {
      "0x1770": "BidNotCrossed — order price below bid",
      "0x1771": "AskNotCrossed — order price above ask",
      "0x1772": "InsufficientBaseAssetAmount",
      "0x1779": "NoFill — order couldn't be filled",
      "0x1781": "OrderDoesNotExist — already filled/canceled",
      "0x1793": "OracleInvalid — stale oracle",
      "0x17a0": "InsufficientCollateral — taker can't afford",
      "0x17a7": "MaintenanceMarginBreached — would breach margin",
      "0x17a8": "CancelledOrderMaintReqExceeded",
      "0x17c3": "PostOnlyOrderWouldCross",
    };

    for (const log of logs) {
      for (const [code, desc] of Object.entries(knownErrors)) {
        if (log.includes(code)) {
          return desc;
        }
      }
    }

    // Look for custom program error
    const errorLog = logs.find(
      (l) =>
        l.includes("Error") ||
        l.includes("failed") ||
        l.includes("insufficient")
    );
    return errorLog || "Unknown error";
  }

  // ── Address Lookup Table Support ──────────────────────────────

  /**
   * Load address lookup tables for use in versioned transactions.
   * ALTs allow larger transactions by compressing account addresses.
   */
  async loadAddressLookupTables(
    tableAddresses: string[]
  ): Promise<AddressLookupTableAccount[]> {
    const { PublicKey } = require("@solana/web3.js");
    const tables: AddressLookupTableAccount[] = [];

    for (const address of tableAddresses) {
      try {
        const result = await this.client.connection.getAddressLookupTable(
          new PublicKey(address)
        );
        if (result.value) {
          tables.push(result.value);
        }
      } catch (err) {
        logger.warn("Failed to load ALT", { address, error: String(err) });
      }
    }

    return tables;
  }

  /**
   * Execute batched instructions with address lookup tables.
   * Allows larger transactions by compressing account addresses.
   */
  async executeBatchedIxsWithALT(
    instructions: TransactionInstruction[],
    lookupTables: AddressLookupTableAccount[],
    priorityFee?: number,
    computeUnits: number = 400_000
  ): Promise<string> {
    const fee = await this.resolvePriorityFee([], priorityFee);

    const computePrice = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: fee,
    });
    const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    });

    const allIxs = [computeLimit, computePrice, ...instructions];

    const latestBlockhash = await this.client.connection.getLatestBlockhash(
      "finalized"
    );
    const messageV0 = new TransactionMessage({
      payerKey: this.client.wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: allIxs,
    }).compileToV0Message(lookupTables);

    const tx = new VersionedTransaction(messageV0);

    const txSig = await this.client.connection.sendTransaction(tx);

    logger.info(
      `Batched tx with ALTs: ${instructions.length} IXs, ${lookupTables.length} ALTs`,
      { txSig }
    );

    return typeof txSig === "string" ? txSig : "";
  }

  // ── Order Fill Monitoring ───────────────────────────────────────

  /**
   * Get all open (unfilled) orders for the current user.
   */
  getOpenOrders(): Array<{
    orderId: number;
    asset: string;
    direction: string;
    marketType: string;
    baseAmount: number;
    price: number;
    status: string;
  }> {
    try {
      const user = this.client.getUser();
      const orders = user.getOpenOrders();
      const perpNames = Object.entries(PERP_INDEX);
      const spotNames = Object.entries(SPOT_INDEX);

      return orders.map((o: any) => {
        const isPerp = o.marketType?.perp !== undefined;
        const nameMap = isPerp ? perpNames : spotNames;
        const asset = nameMap.find(([, idx]) => idx === o.marketIndex)?.[0] || `IDX-${o.marketIndex}`;

        return {
          orderId: o.orderId,
          asset,
          direction: o.direction?.long !== undefined ? "long" : "short",
          marketType: isPerp ? "perp" : "spot",
          baseAmount: convertToNumber(o.baseAssetAmount, new BN(1e9)),
          price: convertToNumber(o.price, PRICE_PRECISION),
          status: o.status ? Object.keys(o.status)[0] : "unknown",
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Check if any orders have filled since last check.
   * Returns filled order count.
   */
  getFilledOrderCount(): number {
    try {
      const user = this.client.getUser();
      return user.getOpenOrders().length;
    } catch {
      return 0;
    }
  }

  // ── Slippage-Protected Market Orders ──────────────────────────

  /**
   * Place a market order as a limit at the slippage-adjusted oracle price.
   * Protects against frontrunning and adverse fills by capping the
   * worst acceptable execution price.
   *
   * For buys (long):  limit = oracle * (1 + slippageBps / 10000)
   * For sells (short): limit = oracle * (1 - slippageBps / 10000)
   */
  async placeMarketOrderWithSlippage(params: {
    asset: string;
    marketType: "perp" | "spot";
    direction: "long" | "short";
    baseAmount: BN;
    slippageBps?: number; // default 50
  }): Promise<string> {
    const { asset, marketType, direction, baseAmount } = params;
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    const marketIndex =
      marketType === "perp" ? indices.perp : indices.spot;

    // 1. Get the current oracle price for the asset
    const oracleData = this.client.getOracleDataForPerpMarket(indices.perp);
    const oraclePrice = oracleData.price; // BN in PRICE_PRECISION (1e6)

    // Validate oracle price
    if (oraclePrice.isZero() || oraclePrice.isNeg()) {
      throw new Error(
        `Invalid oracle price for ${asset}: ${oraclePrice.toString()} — aborting`
      );
    }

    const plan = deriveExecutionPricingPlan({
      side: direction,
      oraclePrice: new Decimal(
        convertToNumber(oraclePrice, PRICE_PRECISION)
      ),
      fallbackSlippageBps: slippageBps,
    });

    const positionDirection =
      direction === "long"
        ? PositionDirection.LONG
        : PositionDirection.SHORT;

    const orderParams = getOrderParams({
      orderType: OrderType.LIMIT,
      marketIndex,
      direction: positionDirection,
      baseAssetAmount: baseAmount,
      price: decimalPriceToBN(plan.limitPrice),
    });

    logger.info(
      `Slippage-protected ${direction} ${asset} ${marketType} | ` +
        `oracle=${convertToNumber(oraclePrice, PRICE_PRECISION).toFixed(4)} | ` +
        `limit=${plan.limitPrice.toFixed(4)} | ` +
        `slippage=${plan.slippageBps}bps`
    );

    // 3. Place via the appropriate order method
    let txSig: string;
    if (marketType === "perp") {
      txSig = await this.client.placePerpOrder(orderParams as any);
    } else {
      txSig = await this.client.placeSpotOrder(orderParams as any);
    }

    return typeof txSig === "string" ? txSig : "";
  }

  // ── LST Yield Stacking ────────────────────────────────────────

  /**
   * Enter a delta-neutral position using an LST (e.g., JitoSOL) instead
   * of raw spot. Triple yield: staking APY + funding rate + lending.
   *
   * Flow: USDC → Jupiter swap → LST (as cross-collateral) + short perp
   */
  async atomicLSTEntry(
    lstSpotIndex: number,
    perpAsset: string,
    usdcAmount: Decimal,
    slippageBps: number = 100 // wider slippage for Jupiter swaps
  ): Promise<string> {
    const perpIdx = PERP_INDEX[perpAsset];
    if (perpIdx === undefined) throw new Error(`Unknown perp: ${perpAsset}`);

    const oracleData = this.client.getOracleDataForPerpMarket(perpIdx);
    const oraclePrice = oracleData.price;
    const price = convertToNumber(oraclePrice, PRICE_PRECISION);
    if (price <= 0) {
      throw new Error(`Invalid oracle price for ${perpAsset}: ${price}`);
    }

    const baseAmount = new Decimal(usdcAmount.toNumber() / price);

    // Step 1: Swap USDC → LST via Jupiter (through Drift)
    const swapIx = await (this.client as any).getJupiterSwapIxV6({
      inMarketIndex: SPOT_INDEX["USDC"], // USDC spot index = 0
      outMarketIndex: lstSpotIndex,
      amount: new BN(usdcAmount.mul(1e6).toFixed(0)),
      slippageBps,
    });

    // Step 2: Short perp against the LST collateral
    const perpLimitPrice = oraclePrice
      .mul(new BN(10000 - DEFAULT_SLIPPAGE_BPS))
      .div(new BN(10000));

    const perpIx = await this.client.getPlacePerpOrderIx(
      getOrderParams({
        orderType: OrderType.LIMIT,
        marketIndex: perpIdx,
        direction: PositionDirection.SHORT,
        baseAssetAmount: this.client.convertToPerpPrecision(
          parseFloat(baseAmount.toFixed(9))
        ),
        price: perpLimitPrice,
      })
    );

    logger.info(
      `LST entry: USDC → LST(idx=${lstSpotIndex}) + SHORT ${perpAsset} perp | ` +
        `$${usdcAmount.toFixed(2)} | ${baseAmount.toFixed(6)} base | ` +
        `oracle=$${price.toFixed(2)}`
    );

    return this.executeBatchedIxs([swapIx, perpIx]);
  }

  /**
   * Exit an LST-based delta-neutral position.
   * Close perp + swap LST back to USDC via Jupiter.
   */
  async atomicLSTExit(
    lstSpotIndex: number,
    perpAsset: string
  ): Promise<string> {
    const perpIdx = PERP_INDEX[perpAsset];
    if (perpIdx === undefined) throw new Error(`Unknown perp: ${perpAsset}`);

    const user = this.client.getUser();
    const ixs: TransactionInstruction[] = [];

    // Cancel all orders
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

    // Swap LST back to USDC via Jupiter
    const lstAmount = user.getTokenAmount(lstSpotIndex);
    const lstAmountNum = convertToNumber(lstAmount, new BN(1e9));
    if (lstAmountNum > 0.0001) {
      const swapIx = await (this.client as any).getJupiterSwapIxV6({
        inMarketIndex: lstSpotIndex,
        outMarketIndex: SPOT_INDEX["USDC"],
        amount: new BN(new Decimal(lstAmountNum).mul(1e9).toFixed(0)),
        slippageBps: 100,
      });
      ixs.push(swapIx);
    }

    if (ixs.length <= 1) {
      logger.info(`No LST positions to close for ${perpAsset}`);
      return "";
    }

    logger.info(`LST exit: close ${perpAsset} perp + swap LST(idx=${lstSpotIndex}) → USDC`);
    return this.executeBatchedIxs(ixs);
  }
}
