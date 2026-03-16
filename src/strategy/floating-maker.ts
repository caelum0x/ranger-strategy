/**
 * FloatingPerpMaker — DLOB market making with oracle-offset orders.
 *
 * Places bid/ask limit orders that automatically track the oracle price.
 * Captures bid-ask spread + earns maker rebates (0.02% per fill).
 *
 * Upgraded with patterns from keeper-bots-v2/src/bots/floatingMaker.ts:
 *   - SlotSubscriber for accurate slot-based cooldown (not RPC polling)
 *   - Mutex protection to prevent concurrent market updates
 *   - Watchdog timer for health monitoring
 *   - Per-market state tracking (positions + open orders)
 *   - Position-aware spread skewing
 */
import {
  DriftClient,
  PerpMarketAccount,
  PerpPosition,
  Order,
  SlotSubscriber,
  calculateAskPrice,
  calculateBidPrice,
  PositionDirection,
  OrderType,
  BASE_PRECISION,
  PRICE_PRECISION,
  convertToNumber,
  isVariant,
  BN,
} from "@drift-labs/sdk";
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from "async-mutex";
import { logger } from "../utils/logger";

// ── Config ──────────────────────────────────────────────────────

export interface FloatingMakerConfig {
  /** Market indices to make on (e.g., [0, 1] for SOL-PERP, BTC-PERP) */
  marketIndices: number[];
  /** Spread bias: 90/100 = place orders 10% tighter than vAMM spread */
  spreadBiasNumerator: number;
  spreadBiasDenominator: number;
  /** Max position as fraction of collateral (10% default) */
  maxPositionExposure: number;
  /** Max quote per order in USDC */
  maxTradeSizeQuote: number;
  /** Minimum slots between order refreshes per market */
  orderRefreshSlots: number;
  /** Oracle staleness threshold in seconds */
  oracleStaleSeconds: number;
}

const DEFAULT_CONFIG: FloatingMakerConfig = {
  marketIndices: [0, 1], // SOL-PERP, BTC-PERP
  spreadBiasNumerator: 90,
  spreadBiasDenominator: 100,
  maxPositionExposure: 0.1,
  maxTradeSizeQuote: 1000,
  orderRefreshSlots: 30, // ~12 seconds at 400ms/slot
  oracleStaleSeconds: 60,
};

// ── Agent State (from keeper-bots-v2) ───────────────────────────

interface AgentState {
  marketPosition: Map<number, PerpPosition>;
  openOrders: Map<number, Order[]>;
}

// ── FloatingPerpMaker ───────────────────────────────────────────

export class FloatingPerpMaker {
  public readonly name: string;
  private client: DriftClient;
  private config: FloatingMakerConfig;

  // SlotSubscriber for accurate slot tracking (from keeper-bots-v2)
  private slotSubscriber: SlotSubscriber | null = null;

  // Per-market slot cooldown tracking (from keeper-bots-v2)
  private lastSlotMarketUpdated: Map<number, number> = new Map();

  // Mutex to prevent concurrent periodic tasks (from keeper-bots-v2)
  private periodicTaskMutex = new Mutex();

  // Watchdog timer (from keeper-bots-v2)
  private watchdogTimerMutex = new Mutex();
  private watchdogTimerLastPatTime = Date.now();

  // Agent state tracking (from keeper-bots-v2)
  private agentState: AgentState | null = null;

  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private defaultIntervalMs = 5000;

  /** Stats */
  private stats = {
    ordersPlaced: 0,
    ordersCanceled: 0,
    updatesSkipped: 0,
    oracleStaleSkips: 0,
    mutexBusy: 0,
    updateCycles: 0,
    lastUpdateDurationMs: 0,
  };

  constructor(
    client: DriftClient,
    config: Partial<FloatingMakerConfig> = {},
    name = "FloatingPerpMaker"
  ) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.name = name;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(intervalMs?: number): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initialize SlotSubscriber (from keeper-bots-v2)
    this.slotSubscriber = new SlotSubscriber(this.client.connection);
    await this.slotSubscriber.subscribe();

    // Initialize agent state
    this.agentState = {
      marketPosition: new Map(),
      openOrders: new Map(),
    };
    this.updateAgentState();

    // Start periodic update loop
    const interval = intervalMs || this.defaultIntervalMs;
    await this.updateOpenOrders();
    this.intervalId = setInterval(
      () => this.updateOpenOrders(),
      interval
    );

    logger.info(`${this.name} started`, {
      markets: this.config.marketIndices,
      bias: `${this.config.spreadBiasNumerator}/${this.config.spreadBiasDenominator}`,
      maxExposure: `${this.config.maxPositionExposure * 100}%`,
      maxTradeSize: `$${this.config.maxTradeSizeQuote}`,
      refreshSlots: this.config.orderRefreshSlots,
      intervalMs: interval,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.slotSubscriber?.unsubscribe();
    this.slotSubscriber = null;
    logger.info(`${this.name} stopped`, { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  /** Watchdog health check (from keeper-bots-v2) */
  async healthCheck(): Promise<boolean> {
    let healthy = false;
    await this.watchdogTimerMutex.runExclusive(async () => {
      healthy =
        this.watchdogTimerLastPatTime >
        Date.now() - 2 * this.defaultIntervalMs;
    });
    return healthy;
  }

  // ── Agent State Tracking (from keeper-bots-v2) ────────────────

  private updateAgentState(): void {
    if (!this.agentState) return;

    // Track positions per market
    try {
      const userAccount = this.client.getUserAccount();
      if (!userAccount) return;

      userAccount.perpPositions.forEach((p) => {
        if (p.baseAssetAmount.isZero()) return;
        this.agentState!.marketPosition.set(p.marketIndex, p);
      });

      // Reset open orders
      for (const market of this.client.getPerpMarketAccounts()) {
        this.agentState!.openOrders.set(market.marketIndex, []);
      }

      // Track open orders per market
      userAccount.orders.forEach((o) => {
        if (isVariant(o.status, "init")) return;
        const existing =
          this.agentState!.openOrders.get(o.marketIndex) || [];
        existing.push(o);
        this.agentState!.openOrders.set(o.marketIndex, existing);
      });
    } catch (err) {
      logger.warn(`${this.name}: failed to update agent state`, {
        error: String(err),
      });
    }
  }

  // ── Core Update Loop (mutex-protected, from keeper-bots-v2) ───

  private async updateOpenOrders(): Promise<void> {
    const start = Date.now();
    let ran = false;

    try {
      await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
        this.updateAgentState();

        await Promise.all(
          this.config.marketIndices.map((marketIndex) =>
            this.updateOpenOrdersForMarket(marketIndex)
          )
        );

        ran = true;
      });
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        this.stats.mutexBusy++;
        logger.debug(`${this.name}: mutex busy, skipping cycle`);
      } else {
        throw e;
      }
    } finally {
      if (ran) {
        const duration = Date.now() - start;
        this.stats.updateCycles++;
        this.stats.lastUpdateDurationMs = duration;

        await this.watchdogTimerMutex.runExclusive(async () => {
          this.watchdogTimerLastPatTime = Date.now();
        });

        logger.debug(`${this.name}: update cycle took ${duration}ms`);
      }
    }
  }

  // ── Per-Market Update (slot-based cooldown from keeper-bots-v2) ──

  private async updateOpenOrdersForMarket(
    marketIndex: number
  ): Promise<void> {
    // Slot-based cooldown check (from keeper-bots-v2)
    const currSlot = this.slotSubscriber?.currentSlot || 0;
    const lastSlot = this.lastSlotMarketUpdated.get(marketIndex) || 0;

    if (currSlot - lastSlot < this.config.orderRefreshSlots) {
      this.stats.updatesSkipped++;
      return;
    }

    const market = this.client.getPerpMarketAccount(marketIndex);
    if (!market) return;

    const oracle = this.client.getOracleDataForPerpMarket(marketIndex);
    const oraclePrice = convertToNumber(oracle.price, PRICE_PRECISION);
    if (oraclePrice <= 0) {
      this.stats.oracleStaleSkips++;
      return;
    }

    // Get open orders from agent state
    const openOrders = this.agentState?.openOrders.get(marketIndex) || [];

    // Calculate vAMM bid/ask (use MM oracle data for compatibility)
    const mmOracle = this.client.getMMOracleDataForPerpMarket(marketIndex);
    const vAsk = calculateAskPrice(market, mmOracle);
    const vBid = calculateBidPrice(market, mmOracle);

    // Decide whether to cancel and re-place (from keeper-bots-v2)
    let placeNewOrders = openOrders.length === 0;

    if (openOrders.length > 0 && openOrders.length !== 2) {
      // Should always have exactly 2 (bid + ask) — cancel and re-place
      for (const o of openOrders) {
        try {
          await this.client.cancelOrder(o.orderId);
          this.stats.ordersCanceled++;
        } catch {
          // Order may have been filled
        }
      }
      placeNewOrders = true;
    }

    if (!placeNewOrders) {
      this.lastSlotMarketUpdated.set(marketIndex, currSlot);
      return;
    }

    // Calculate spreads from oracle
    const oracleBidSpread = oracle.price.sub(vBid);
    const oracleAskSpread = vAsk.sub(oracle.price);

    // Get current position for inventory skew
    const user = this.client.getUser();
    const perpPos = user.getPerpPosition(marketIndex);
    const currentBase = perpPos
      ? convertToNumber(perpPos.baseAssetAmount, BASE_PRECISION)
      : 0;

    // Position exposure check
    const collateral = convertToNumber(
      user.getTotalCollateral(),
      new BN(1e6)
    );
    const positionNotional = Math.abs(currentBase) * oraclePrice;
    const exposureRatio = collateral > 0 ? positionNotional / collateral : 0;

    if (exposureRatio > this.config.maxPositionExposure * 1.5) {
      logger.info(
        `${this.name}: market ${marketIndex} over-exposed (${(exposureRatio * 100).toFixed(1)}%), skipping`
      );
      return;
    }

    // Inventory-adjusted spreads
    const { bidOffset, askOffset } = this.calculateInventoryAdjustedSpread(
      currentBase,
      collateral,
      oracleBidSpread,
      oracleAskSpread
    );

    // Calculate order size
    const orderSizeQuote = Math.min(
      this.config.maxTradeSizeQuote,
      collateral * this.config.maxPositionExposure * 0.5
    );
    const orderSizeBase = oraclePrice > 0 ? orderSizeQuote / oraclePrice : 0;
    if (orderSizeBase <= 0) return;

    const baseBN = new BN(Math.abs(orderSizeBase * 1e9).toFixed(0));

    // Place bid (below oracle)
    try {
      await this.client.placePerpOrder({
        orderType: OrderType.LIMIT,
        marketIndex,
        direction: PositionDirection.LONG,
        baseAssetAmount: baseBN,
        oraclePriceOffset: bidOffset,
        postOnly: true,
      } as any);
      this.stats.ordersPlaced++;
    } catch (err) {
      logger.warn(`${this.name}: bid failed on market ${marketIndex}`, {
        error: String(err),
      });
    }

    // Place ask (above oracle)
    try {
      await this.client.placePerpOrder({
        orderType: OrderType.LIMIT,
        marketIndex,
        direction: PositionDirection.SHORT,
        baseAssetAmount: baseBN,
        oraclePriceOffset: askOffset,
        postOnly: true,
      } as any);
      this.stats.ordersPlaced++;
    } catch (err) {
      logger.warn(`${this.name}: ask failed on market ${marketIndex}`, {
        error: String(err),
      });
    }

    // Enforce slot cooldown (from keeper-bots-v2)
    this.lastSlotMarketUpdated.set(marketIndex, currSlot);

    logger.debug(`${this.name}: updated market`, {
      marketIndex,
      oraclePrice: oraclePrice.toFixed(4),
      bidOffset,
      askOffset,
      orderSizeBase: orderSizeBase.toFixed(6),
      currentPosition: currentBase.toFixed(6),
      exposureRatio: (exposureRatio * 100).toFixed(1) + "%",
      slot: currSlot,
    });
  }

  // ── Inventory-Adjusted Spreads ────────────────────────────────

  /**
   * Adjust spreads based on inventory position.
   * When long, widen bid (discourage more longs) and tighten ask (encourage closes).
   * When short, widen ask and tighten bid.
   */
  private calculateInventoryAdjustedSpread(
    currentBase: number,
    collateral: number,
    oracleBidSpread: BN,
    oracleAskSpread: BN
  ): { bidOffset: number; askOffset: number } {
    const { spreadBiasNumerator: num, spreadBiasDenominator: den } =
      this.config;

    // Base offsets (tighter than vAMM by bias factor)
    let bidSpread = oracleBidSpread.mul(new BN(num)).div(new BN(den));
    let askSpread = oracleAskSpread.mul(new BN(num)).div(new BN(den));

    // Inventory skew factor
    if (currentBase !== 0 && collateral > 0) {
      const inventoryRatio = Math.min(
        1,
        Math.abs(currentBase * convertToNumber(new BN(1), PRICE_PRECISION)) /
          (collateral * this.config.maxPositionExposure)
      );

      if (currentBase > 0) {
        // LONG → widen bid (more below oracle), tighten ask (closer to oracle)
        const widenFactor = new BN(Math.floor(1000 + inventoryRatio * 500));
        const tightenFactor = new BN(
          Math.floor(1000 - inventoryRatio * 300)
        );
        bidSpread = bidSpread.mul(widenFactor).div(new BN(1000));
        askSpread = askSpread.mul(tightenFactor).div(new BN(1000));
      } else {
        // SHORT → widen ask, tighten bid
        const tightenFactor = new BN(
          Math.floor(1000 - inventoryRatio * 300)
        );
        const widenFactor = new BN(Math.floor(1000 + inventoryRatio * 500));
        bidSpread = bidSpread.mul(tightenFactor).div(new BN(1000));
        askSpread = askSpread.mul(widenFactor).div(new BN(1000));
      }
    }

    return {
      bidOffset: -Math.abs(bidSpread.toNumber()), // negative = below oracle
      askOffset: Math.abs(askSpread.toNumber()), // positive = above oracle
    };
  }
}
