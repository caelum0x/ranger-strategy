/**
 * Grid Order Strategy — scale orders across a price range.
 *
 * From Drift Workshop: "Scale orders demo: placing five staggered buy orders
 * across a price range" — this is what the Drift team specifically recommended.
 *
 * Places a grid of oracle-offset limit orders at evenly spaced intervals
 * around the current oracle price. As prices move through the grid:
 *   - Buy orders get filled on dips → accumulate position
 *   - Sell orders get filled on pumps → take profit
 *   - Net effect: captures volatility regardless of direction
 *
 * Combined with our delta-neutral strategy, grid orders add:
 *   - Spread capture on every fill
 *   - Maker rebates (0.02% per fill)
 *   - Mean-reversion alpha in ranging markets
 *
 * Uses Drift's oracle-offset orders so the grid automatically
 * moves with the oracle price — zero maintenance.
 */
import {
  DriftClient,
  BN,
  PositionDirection,
  OrderType,
  BASE_PRECISION,
  PRICE_PRECISION,
  convertToNumber,
  PostOnlyParams,
} from "@drift-labs/sdk";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface GridConfig {
  /** Perp market index (0=SOL, 1=BTC, 2=ETH) */
  marketIndex: number;
  /** Number of grid levels on each side (buy + sell) */
  gridLevels: number;
  /** Spacing between grid levels in price ticks (oracle offset) */
  gridSpacing: number;
  /** Order size per grid level (in base asset) */
  orderSize: number;
  /** Maximum total position size (prevents runaway accumulation) */
  maxPosition: number;
  /** Refresh interval (slots) */
  refreshSlots: number;
}

const DEFAULT_GRID_CONFIG: GridConfig = {
  marketIndex: 0, // SOL-PERP
  gridLevels: 5,  // 5 buys + 5 sells = 10 orders
  gridSpacing: 50, // 50 ticks between levels (~$0.05 for SOL)
  orderSize: 0.1,  // 0.1 SOL per level
  maxPosition: 1.0, // max 1 SOL total
  refreshSlots: 60, // refresh every ~24 seconds
};

// ── Grid Order Strategy ─────────────────────────────────────────

export class GridOrderStrategy {
  private client: DriftClient;
  private configs: GridConfig[];
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastRefreshSlot: Map<number, number> = new Map();

  private stats = {
    ordersPlaced: 0,
    ordersCanceled: 0,
    refreshCycles: 0,
    gridsActive: 0,
  };

  constructor(
    client: DriftClient,
    configs: Partial<GridConfig>[] = [{}]
  ) {
    this.client = client;
    this.configs = configs.map((c) => ({ ...DEFAULT_GRID_CONFIG, ...c }));
  }

  // ── Lifecycle ───────────────────────────────────────────────

  start(intervalMs = 10_000): void {
    if (this.running) return;
    this.running = true;

    this.intervalId = setInterval(() => {
      this.refreshAllGrids().catch((err) => {
        logger.warn("Grid order refresh error", { error: String(err) });
      });
    }, intervalMs);

    logger.info("Grid order strategy started", {
      markets: this.configs.map((c) => c.marketIndex),
      levels: this.configs.map((c) => `${c.gridLevels}x2`),
      spacing: this.configs.map((c) => c.gridSpacing),
    });
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("Grid order strategy stopped", { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  // ── Core Logic ────────────────────────────────────────────────

  private async refreshAllGrids(): Promise<void> {
    for (const config of this.configs) {
      await this.refreshGrid(config);
    }
    this.stats.refreshCycles++;
  }

  /**
   * Place or refresh a grid of oracle-offset orders.
   *
   * From Drift Workshop (00:26:17):
   *   "Scale orders demo: placing five staggered buy orders across a price range"
   *
   * We place:
   *   - N buy orders below oracle (negative offsets)
   *   - N sell orders above oracle (positive offsets)
   *   - All with postOnly=true for maker rebates
   *   - All with oracle offset so they auto-track price
   */
  private async refreshGrid(config: GridConfig): Promise<void> {
    // Check if we need to refresh
    const currentSlot = Date.now(); // simplified — use SlotSubscriber in production
    const lastSlot = this.lastRefreshSlot.get(config.marketIndex) || 0;
    if (currentSlot - lastSlot < config.refreshSlots * 400) return; // ~400ms per slot

    // Check current position vs max
    try {
      const user = this.client.getUser();
      const perpPos = user.getPerpPosition(config.marketIndex);
      const currentBase = perpPos
        ? Math.abs(convertToNumber(perpPos.baseAssetAmount, BASE_PRECISION))
        : 0;

      if (currentBase >= config.maxPosition) {
        logger.debug("Grid: max position reached, skipping", {
          marketIndex: config.marketIndex,
          current: currentBase.toFixed(4),
          max: config.maxPosition,
        });
        return;
      }
    } catch {
      // Can't check position — skip
      return;
    }

    // Cancel existing orders for this market
    try {
      await (this.client as any).cancelOrders(
        { perp: {} },
        config.marketIndex,
        null
      );
      this.stats.ordersCanceled++;
    } catch {
      // No orders to cancel
    }

    // Place grid orders
    const orderSize = new BN(
      Math.floor(config.orderSize * 1e9).toString()
    );

    // Buy side (below oracle)
    for (let i = 1; i <= config.gridLevels; i++) {
      const offset = -(config.gridSpacing * i); // negative = below oracle

      try {
        await this.client.placePerpOrder({
          orderType: OrderType.LIMIT,
          marketIndex: config.marketIndex,
          direction: PositionDirection.LONG,
          baseAssetAmount: orderSize,
          oraclePriceOffset: offset,
          postOnly: PostOnlyParams.MUST_POST_ONLY,
        } as any);
        this.stats.ordersPlaced++;
      } catch {
        // Order placement failed — continue to next level
      }
    }

    // Sell side (above oracle)
    for (let i = 1; i <= config.gridLevels; i++) {
      const offset = config.gridSpacing * i; // positive = above oracle

      try {
        await this.client.placePerpOrder({
          orderType: OrderType.LIMIT,
          marketIndex: config.marketIndex,
          direction: PositionDirection.SHORT,
          baseAssetAmount: orderSize,
          oraclePriceOffset: offset,
          postOnly: PostOnlyParams.MUST_POST_ONLY,
        } as any);
        this.stats.ordersPlaced++;
      } catch {
        // Continue to next level
      }
    }

    this.lastRefreshSlot.set(config.marketIndex, currentSlot);
    this.stats.gridsActive = this.configs.length;

    logger.debug("Grid: refreshed orders", {
      marketIndex: config.marketIndex,
      levels: `${config.gridLevels} buy + ${config.gridLevels} sell`,
      spacing: config.gridSpacing,
      orderSize: config.orderSize,
    });
  }
}
