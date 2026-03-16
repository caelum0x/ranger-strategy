/**
 * JIT (Just-In-Time) Liquidity Maker — ported from jit-proxy SDK.
 *
 * Two fill strategies:
 *   - Sniper: calculates exact slot when auction price crosses our bid/ask,
 *             waits for that slot, then fills. Optimal for large orders.
 *   - Shotgun: rapid-fire retry every slot during auction. Simpler, catches
 *              more orders but may waste compute.
 *
 * Uses AuctionSubscriber + SlotSubscriber from @drift-labs/sdk for real-time
 * auction detection and precise slot-based timing.
 *
 * Ported from:
 *   - jit-proxy/ts/sdk/src/jitter/jitterSniper.ts
 *   - jit-proxy/ts/sdk/src/jitter/jitterShotgun.ts
 *   - jit-proxy/ts/sdk/src/jitter/baseJitter.ts
 */
import {
  DriftClient,
  AuctionSubscriber,
  SlotSubscriber,
  UserAccount,
  Order,
  BN,
  isVariant,
  getVariant,
  hasAuctionPrice,
  getAuctionPrice,
  getAuctionPriceForOracleOffsetAuction,
  getLimitPrice,
  convertToNumber,
  PRICE_PRECISION,
  BASE_PRECISION,
  PositionDirection,
  OrderType,
  PostOnlyParams,
  ZERO,
  OraclePriceData,
  UserMap,
  getUserStatsAccountPublicKey,
} from "@drift-labs/sdk";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface JitParams {
  /** Bid offset from oracle price (BN in PRICE_PRECISION, negative = below oracle) */
  bid: BN;
  /** Ask offset from oracle price (BN in PRICE_PRECISION, positive = above oracle) */
  ask: BN;
  /** Minimum position size (BN, negative for max short) */
  minPosition: BN;
  /** Maximum position size (BN, positive for max long) */
  maxPosition: BN;
  /** Price type: 'oracle' for oracle-relative, 'fixed' for absolute */
  priceType: "oracle" | "fixed";
  /** Sub-account to trade on */
  subAccountId?: number;
}

type AuctionAndOrderDetails = {
  slotsTilCross: number;
  willCross: boolean;
  bid: number;
  ask: number;
  auctionStartPrice: number;
  auctionEndPrice: number;
  stepSize: number;
  oraclePrice: OraclePriceData;
};

export type JitFillMode = "sniper" | "shotgun";

// ── JIT Maker ───────────────────────────────────────────────────

export class JitMaker {
  private client: DriftClient;
  private auctionSubscriber: AuctionSubscriber | null = null;
  private slotSubscriber: SlotSubscriber | null = null;
  private userMap: UserMap | null = null;

  private perpParams: Map<number, JitParams> = new Map();
  private spotParams: Map<number, JitParams> = new Map();

  private seenOrders = new Set<string>();
  private ongoingAuctions = new Map<string, Promise<void>>();

  private running = false;
  private mode: JitFillMode;
  private computeUnits = 1_400_000;
  private computeUnitsPrice = 50_000;

  /** Stats */
  private stats = {
    auctionsDetected: 0,
    fillsAttempted: 0,
    fillsSucceeded: 0,
    fillsFailed: 0,
    auctionsExpired: 0,
    positionLimitSkips: 0,
  };

  constructor(
    client: DriftClient,
    mode: JitFillMode = "sniper"
  ) {
    this.client = client;
    this.mode = mode;
  }

  // ── Configuration ───────────────────────────────────────────

  setPerpParams(marketIndex: number, params: JitParams): void {
    this.perpParams.set(marketIndex, params);
    logger.info("JIT: set perp params", {
      marketIndex,
      bid: params.bid.toString(),
      ask: params.ask.toString(),
      mode: this.mode,
    });
  }

  setSpotParams(marketIndex: number, params: JitParams): void {
    this.spotParams.set(marketIndex, params);
  }

  removePerpParams(marketIndex: number): void {
    this.perpParams.delete(marketIndex);
  }

  removeSpotParams(marketIndex: number): void {
    this.spotParams.delete(marketIndex);
  }

  setComputeUnits(cu: number): void {
    this.computeUnits = cu;
  }

  setComputeUnitsPrice(price: number): void {
    this.computeUnitsPrice = price;
  }

  getStats() {
    return { ...this.stats };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initialize SlotSubscriber for real-time slot tracking
    this.slotSubscriber = new SlotSubscriber(this.client.connection);
    await this.slotSubscriber.subscribe();

    // Initialize AuctionSubscriber to detect new auction orders
    this.auctionSubscriber = new AuctionSubscriber({
      driftClient: this.client,
    } as any);
    await this.auctionSubscriber.subscribe();

    // Listen for new auction orders
    this.auctionSubscriber.eventEmitter.on(
      "onAccountUpdate",
      async (taker: UserAccount, takerKey: PublicKey, slot: number) => {
        await this.handleAuctionUpdate(taker, takerKey, slot);
      }
    );

    logger.info("JIT maker started", {
      mode: this.mode,
      perpMarkets: [...this.perpParams.keys()],
      spotMarkets: [...this.spotParams.keys()],
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.slotSubscriber?.unsubscribe();
    await this.auctionSubscriber?.unsubscribe();
    this.slotSubscriber = null;
    this.auctionSubscriber = null;
    logger.info("JIT maker stopped", { stats: this.stats });
  }

  // ── Auction Detection (from baseJitter.ts) ──────────────────

  private async handleAuctionUpdate(
    taker: UserAccount,
    takerKey: PublicKey,
    slot: number
  ): Promise<void> {
    const takerKeyString = takerKey.toBase58();
    const takerStatsKey = getUserStatsAccountPublicKey(
      this.client.program.programId,
      taker.authority
    );

    for (const order of taker.orders) {
      if (!isVariant(order.status, "open")) continue;
      if (!hasAuctionPrice(order, slot)) continue;

      const orderSignature = `${takerKeyString}-${order.orderId}`;
      if (this.seenOrders.has(orderSignature)) continue;
      if (this.ongoingAuctions.has(orderSignature)) continue;

      // Check if we have params for this market
      const isPerp = isVariant(order.marketType, "perp");
      const params = isPerp
        ? this.perpParams.get(order.marketIndex)
        : this.spotParams.get(order.marketIndex);
      if (!params) continue;

      // Check minimum order size
      if (isPerp) {
        const perpMarket = this.client.getPerpMarketAccount(order.marketIndex);
        if (
          perpMarket &&
          order.baseAssetAmount
            .sub(order.baseAssetAmountFilled)
            .lte(perpMarket.amm.minOrderSize)
        ) {
          continue;
        }
      }

      this.seenOrders.add(orderSignature);
      this.stats.auctionsDetected++;

      // Dispatch to fill strategy
      const fillFn =
        this.mode === "sniper"
          ? this.createSniperFill(taker, takerKey, takerStatsKey, order, orderSignature)
          : this.createShotgunFill(taker, takerKey, takerStatsKey, order, orderSignature);

      const promise = fillFn();
      this.ongoingAuctions.set(orderSignature, promise);
    }
  }

  // ── Sniper Strategy (from jitterSniper.ts) ──────────────────

  private createSniperFill(
    taker: UserAccount,
    takerKey: PublicKey,
    takerStatsKey: PublicKey,
    order: Order,
    orderSignature: string
  ): () => Promise<void> {
    return async () => {
      try {
        const params = isVariant(order.marketType, "perp")
          ? this.perpParams.get(order.marketIndex)
          : this.spotParams.get(order.marketIndex);
        if (!params) {
          this.deleteOngoingAuction(orderSignature);
          return;
        }

        // Check position limits
        if (!this.checkPositionLimits(order, params)) {
          this.deleteOngoingAuction(orderSignature);
          return;
        }

        const details = this.getAuctionAndOrderDetails(order);

        logger.info("JIT Sniper: detected auction", {
          taker: takerKey.toBase58().slice(0, 8),
          direction: JSON.stringify(order.direction),
          market: `${getVariant(order.marketType)}-${order.marketIndex}`,
          bid: details.bid.toFixed(4),
          ask: details.ask.toFixed(4),
          auctionStart: details.auctionStartPrice.toFixed(4),
          auctionEnd: details.auctionEndPrice.toFixed(4),
          willCross: details.willCross,
          slotsTilCross: details.slotsTilCross,
          currentSlot: this.slotSubscriber?.currentSlot,
        });

        // Calculate target slot
        const targetSlot = details.willCross
          ? order.slot.toNumber() + details.slotsTilCross
          : order.slot.toNumber() + order.auctionDuration + 1;

        // Wait for optimal fill slot
        const { slot: fillSlot, updatedDetails } =
          await this.waitForSlotOrCrossOrExpiry(targetSlot, order, details);

        if (fillSlot === -1) {
          this.stats.auctionsExpired++;
          logger.debug("JIT Sniper: auction expired without crossing", {
            orderSignature,
          });
          this.deleteOngoingAuction(orderSignature);
          return;
        }

        // Attempt fill with retries
        await this.executeFill(
          taker,
          takerKey,
          order,
          params,
          updatedDetails.oraclePrice,
          orderSignature,
          fillSlot
        );
      } catch (err) {
        logger.warn("JIT Sniper: error", {
          orderSignature,
          error: String(err),
        });
      } finally {
        this.deleteOngoingAuction(orderSignature);
      }
    };
  }

  // ── Shotgun Strategy (from jitterShotgun.ts) ────────────────

  private createShotgunFill(
    taker: UserAccount,
    takerKey: PublicKey,
    takerStatsKey: PublicKey,
    order: Order,
    orderSignature: string
  ): () => Promise<void> {
    return async () => {
      try {
        let attempt = 0;

        // Retry every ~slot during auction duration
        while (attempt < order.auctionDuration && this.running) {
          const params = isVariant(order.marketType, "perp")
            ? this.perpParams.get(order.marketIndex)
            : this.spotParams.get(order.marketIndex);
          if (!params) break;

          if (!this.checkPositionLimits(order, params)) break;

          const oraclePrice = isVariant(order.marketType, "perp")
            ? this.client.getOracleDataForPerpMarket(order.marketIndex)
            : this.client.getOracleDataForSpotMarket(order.marketIndex);

          try {
            await this.executeSingleFill(
              taker,
              takerKey,
              order,
              params,
              oraclePrice,
              orderSignature
            );
            // Success — done
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("0x1770") || msg.includes("0x1771")) {
              // Price not crossed yet — retry
              logger.debug("JIT Shotgun: price not crossed yet, retrying", {
                attempt,
                orderSignature,
              });
            } else if (msg.includes("0x1779")) {
              // Order could not fill — stop
              break;
            } else if (msg.includes("0x1793")) {
              // Oracle invalid — retry
              logger.debug("JIT Shotgun: oracle invalid, retrying");
            } else {
              // Unknown error — stop
              logger.warn("JIT Shotgun: unexpected error", { error: msg });
              break;
            }
          }

          attempt++;
          await sleep(400); // ~1 slot
        }
      } catch (err) {
        logger.warn("JIT Shotgun: error", {
          orderSignature,
          error: String(err),
        });
      } finally {
        this.deleteOngoingAuction(orderSignature);
      }
    };
  }

  // ── Auction Analysis (from jitterSniper.getAuctionAndOrderDetails) ──

  private getAuctionAndOrderDetails(order: Order): AuctionAndOrderDetails {
    const params = isVariant(order.marketType, "perp")
      ? this.perpParams.get(order.marketIndex)!
      : this.spotParams.get(order.marketIndex)!;
    const oraclePrice = isVariant(order.marketType, "perp")
      ? this.client.getOracleDataForPerpMarket(order.marketIndex)
      : this.client.getOracleDataForSpotMarket(order.marketIndex);

    // Our bid/ask prices
    const makerOrderDir = isVariant(order.direction, "long") ? "sell" : "buy";
    const auctionStartPrice = convertToNumber(
      isVariant(order.orderType, "oracle")
        ? getAuctionPriceForOracleOffsetAuction(
            order,
            order.slot.toNumber(),
            oraclePrice.price
          )
        : order.auctionStartPrice,
      PRICE_PRECISION
    );
    const auctionEndPrice = convertToNumber(
      isVariant(order.orderType, "oracle")
        ? getAuctionPriceForOracleOffsetAuction(
            order,
            order.slot.toNumber() + order.auctionDuration - 1,
            oraclePrice.price
          )
        : order.auctionEndPrice,
      PRICE_PRECISION
    );

    const bid =
      params.priceType === "oracle"
        ? convertToNumber(oraclePrice.price.add(params.bid), PRICE_PRECISION)
        : convertToNumber(params.bid, PRICE_PRECISION);
    const ask =
      params.priceType === "oracle"
        ? convertToNumber(oraclePrice.price.add(params.ask), PRICE_PRECISION)
        : convertToNumber(params.ask, PRICE_PRECISION);

    // Calculate slots until auction price crosses our bid/ask
    let slotsTilCross = 0;
    let willCross = false;
    const stepSize =
      order.auctionDuration > 1
        ? (auctionEndPrice - auctionStartPrice) / (order.auctionDuration - 1)
        : 0;

    while (slotsTilCross < order.auctionDuration) {
      const auctionPriceAtSlot = convertToNumber(
        getAuctionPrice(
          order,
          order.slot.toNumber() + slotsTilCross,
          oraclePrice.price
        ),
        PRICE_PRECISION
      );

      if (makerOrderDir === "buy" && auctionPriceAtSlot <= bid) {
        willCross = true;
        break;
      }
      if (makerOrderDir === "sell" && auctionPriceAtSlot >= ask) {
        willCross = true;
        break;
      }
      slotsTilCross++;
    }

    // Check limit price after auction ends
    if (!willCross) {
      const slotAfterAuction =
        order.slot.toNumber() + order.auctionDuration + 1;
      const limitPrice = getLimitPrice(order, oraclePrice, slotAfterAuction);
      if (!limitPrice) {
        willCross = true;
        slotsTilCross = order.auctionDuration + 1;
      } else {
        const limitPriceNum = convertToNumber(limitPrice, PRICE_PRECISION);
        if (
          (makerOrderDir === "buy" && limitPriceNum <= bid) ||
          (makerOrderDir === "sell" && limitPriceNum >= ask)
        ) {
          willCross = true;
          slotsTilCross = order.auctionDuration + 1;
        }
      }
    }

    return {
      slotsTilCross,
      willCross,
      bid,
      ask,
      auctionStartPrice,
      auctionEndPrice,
      stepSize,
      oraclePrice,
    };
  }

  // ── Slot Waiting (from jitterSniper.waitForSlotOrCrossOrExpiry) ──

  private async waitForSlotOrCrossOrExpiry(
    targetSlot: number,
    order: Order,
    initialDetails: AuctionAndOrderDetails
  ): Promise<{ slot: number; updatedDetails: AuctionAndOrderDetails }> {
    let currentDetails = initialDetails;
    let currentTarget = targetSlot;
    let willCross = initialDetails.willCross;

    const currentSlot = this.slotSubscriber?.currentSlot || 0;
    if (currentSlot > currentTarget) {
      return {
        slot: willCross ? currentSlot : -1,
        updatedDetails: currentDetails,
      };
    }

    return new Promise((resolve) => {
      const slotListener = (slot: number) => {
        if (slot >= currentTarget && willCross) {
          cleanup();
          resolve({ slot, updatedDetails: currentDetails });
        }
      };

      // Listen for new slots
      this.slotSubscriber?.eventEmitter.on("newSlot", slotListener);

      // Periodically re-evaluate as oracle moves
      const intervalId = setInterval(() => {
        const nowSlot = this.slotSubscriber?.currentSlot || 0;

        if (nowSlot >= currentTarget) {
          cleanup();
          resolve({
            slot: willCross ? nowSlot : -1,
            updatedDetails: currentDetails,
          });
          return;
        }

        // Re-calculate with updated oracle
        currentDetails = this.getAuctionAndOrderDetails(order);
        willCross = currentDetails.willCross;
        if (willCross) {
          currentTarget = order.slot.toNumber() + currentDetails.slotsTilCross;
        }
      }, 50);

      // Timeout: don't wait forever
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve({ slot: -1, updatedDetails: currentDetails });
      }, 30_000);

      const cleanup = () => {
        this.slotSubscriber?.eventEmitter.removeListener("newSlot", slotListener);
        clearInterval(intervalId);
        clearTimeout(timeoutId);
      };
    });
  }

  // ── Position Limit Check (from jitterSniper) ──────────────────

  private checkPositionLimits(order: Order, params: JitParams): boolean {
    if (!isVariant(order.marketType, "perp")) return true;

    try {
      const currPerpPos =
        this.client.getUser().getPerpPosition(order.marketIndex) ||
        this.client.getUser().getEmptyPosition(order.marketIndex);

      // If we're short and taker wants to sell (we'd buy = go more long/less short)
      // That's fine. But if taker wants to buy (we'd sell = go more short):
      if (
        currPerpPos.baseAssetAmount.lt(ZERO) &&
        isVariant(order.direction, "short")
      ) {
        if (currPerpPos.baseAssetAmount.lte(params.minPosition)) {
          this.stats.positionLimitSkips++;
          logger.debug("JIT: would increase short past min position", {
            marketIndex: order.marketIndex,
            currentPos: currPerpPos.baseAssetAmount.toString(),
            minPosition: params.minPosition.toString(),
          });
          return false;
        }
      } else if (
        currPerpPos.baseAssetAmount.gt(ZERO) &&
        isVariant(order.direction, "long")
      ) {
        if (currPerpPos.baseAssetAmount.gte(params.maxPosition)) {
          this.stats.positionLimitSkips++;
          logger.debug("JIT: would increase long past max position", {
            marketIndex: order.marketIndex,
            currentPos: currPerpPos.baseAssetAmount.toString(),
            maxPosition: params.maxPosition.toString(),
          });
          return false;
        }
      }
    } catch {
      // Can't check position — allow fill
    }

    return true;
  }

  // ── Fill Execution ────────────────────────────────────────────

  private async executeFill(
    taker: UserAccount,
    takerKey: PublicKey,
    order: Order,
    params: JitParams,
    oraclePrice: OraclePriceData,
    orderSignature: string,
    fillSlot: number
  ): Promise<void> {
    const auctionPrice = convertToNumber(
      getAuctionPrice(order, fillSlot, oraclePrice.price),
      PRICE_PRECISION
    );

    logger.info("JIT: attempting fill", {
      orderSignature,
      auctionPrice: auctionPrice.toFixed(4),
      fillSlot,
    });

    let retries = 0;
    while (retries < 10) {
      try {
        await this.executeSingleFill(
          taker,
          takerKey,
          order,
          params,
          oraclePrice,
          orderSignature
        );
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("0x1770") || msg.includes("0x1771")) {
          // Not crossed yet — retry
        } else if (msg.includes("0x1779")) {
          logger.debug("JIT: order could not fill", { orderSignature });
          return;
        } else if (msg.includes("0x1793")) {
          // Oracle invalid — retry
        } else {
          logger.warn("JIT: fill error", { orderSignature, error: msg });
          return;
        }
      }
      await sleep(200);
      retries++;
    }
  }

  private async executeSingleFill(
    taker: UserAccount,
    takerKey: PublicKey,
    order: Order,
    params: JitParams,
    oraclePrice: OraclePriceData,
    orderSignature: string
  ): Promise<void> {
    this.stats.fillsAttempted++;

    // Our fill direction is opposite to taker
    const ourDirection = isVariant(order.direction, "long")
      ? PositionDirection.SHORT
      : PositionDirection.LONG;

    // Calculate our limit price from params
    const ourLimitPrice =
      params.priceType === "oracle"
        ? isVariant(order.direction, "long")
          ? oraclePrice.price.add(params.ask) // taker buys → we sell at our ask
          : oraclePrice.price.add(params.bid) // taker sells → we buy at our bid
        : isVariant(order.direction, "long")
          ? params.ask
          : params.bid;

    // Fill amount: match taker's remaining amount, capped by our limits
    const remainingBase = order.baseAssetAmount.sub(order.baseAssetAmountFilled);

    const txSig = await this.client.placePerpOrder(
      {
        orderType: OrderType.LIMIT,
        marketIndex: order.marketIndex,
        direction: ourDirection,
        baseAssetAmount: remainingBase,
        price: ourLimitPrice,
        postOnly: PostOnlyParams.MUST_POST_ONLY,
        immediateOrCancel: true,
      } as any,
      {
        computeUnits: this.computeUnits,
        computeUnitsPrice: this.computeUnitsPrice,
      } as any
    );

    this.stats.fillsSucceeded++;
    logger.info("JIT: fill succeeded", {
      orderSignature,
      txSig,
      marketIndex: order.marketIndex,
      direction: getVariant(ourDirection),
      baseAmount: convertToNumber(remainingBase, BASE_PRECISION).toFixed(6),
      limitPrice: convertToNumber(ourLimitPrice, PRICE_PRECISION).toFixed(4),
    });
  }

  // ── Helpers ───────────────────────────────────────────────────

  private deleteOngoingAuction(orderSignature: string): void {
    this.ongoingAuctions.delete(orderSignature);
    this.seenOrders.delete(orderSignature);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
