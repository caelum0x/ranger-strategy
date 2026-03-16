/**
 * Order Filler Bot — ported from keeper-bots-v2/src/bots/filler.ts.
 *
 * Fills resting orders on the DLOB (Decentralized Limit Order Book).
 * Earns filler rewards for matching makers with takers.
 *
 * Key features (from keeper-bots-v2):
 *   - DLOB-based order discovery (NodeToFill)
 *   - Multi-maker fills: packs multiple makers per tx for better matching
 *   - Trigger order execution: fires trigger/stop orders when conditions met
 *   - Fill throttling: prevents re-filling same user/order rapidly
 *   - Transaction simulation: estimates CU before sending
 *   - Versioned transactions with compute budget control
 *   - PnL settlement after fills
 */
import {
  DriftClient,
  UserMap,
  SlotSubscriber,
  DLOB,
  DLOBNode,
  NodeToFill,
  NodeToTrigger,
  MakerInfo,
  MarketType,
  PositionDirection,
  OrderType,
  BN,
  ZERO,
  PRICE_PRECISION,
  BASE_PRECISION,
  convertToNumber,
  isVariant,
  getVariant,
  getUserStatsAccountPublicKey,
  getMarketOrderParams,
  TxParams,
  PriorityFeeSubscriber,
  PriorityFeeMethod,
} from "@drift-labs/sdk";
import {
  Connection,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { logger } from "../utils/logger";
import { config } from "../config";

// ── Types ───────────────────────────────────────────────────────

interface FillerConfig {
  /** Markets to fill on */
  perpMarketIndices: number[];
  /** How often to scan DLOB (ms) */
  fillIntervalMs: number;
  /** Max fills per cycle */
  maxFillsPerCycle: number;
  /** Max trigger orders per cycle */
  maxTriggersPerCycle: number;
  /** Throttle backoff per user (ms) */
  throttleBackoffMs: number;
  /** Compute units per fill tx */
  computeUnitsPerFill: number;
  /** Enable PnL settlement after fills */
  settlePnl: boolean;
  /** Dry run mode (no txs) */
  dryRun: boolean;
}

const DEFAULT_FILLER_CONFIG: FillerConfig = {
  perpMarketIndices: [0, 1, 2], // SOL, BTC, ETH
  fillIntervalMs: 6_000,
  maxFillsPerCycle: 10,
  maxTriggersPerCycle: 5,
  throttleBackoffMs: 10_000,
  computeUnitsPerFill: 1_400_000,
  settlePnl: true,
  dryRun: false,
};

interface ThrottleEntry {
  lastAttempt: number;
  consecutiveFailures: number;
}

// ── Filler Bot ──────────────────────────────────────────────────

export class FillerBot {
  public readonly name: string;
  private client: DriftClient;
  private config: FillerConfig;

  private userMap: UserMap | null = null;
  private slotSubscriber: SlotSubscriber | null = null;
  private priorityFeeSubscriber: PriorityFeeSubscriber | null = null;

  private running = false;
  private tickInProgress = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  // Throttle tracking (from keeper-bots-v2)
  private throttledNodes = new Map<string, ThrottleEntry>();

  /** Stats */
  private stats = {
    fillsAttempted: 0,
    fillsSucceeded: 0,
    fillsFailed: 0,
    triggersAttempted: 0,
    triggersSucceeded: 0,
    triggersFailed: 0,
    pnlSettlements: 0,
    throttled: 0,
    cyclesCompleted: 0,
    lastCycleDurationMs: 0,
  };

  constructor(
    client: DriftClient,
    config: Partial<FillerConfig> = {},
    name = "FillerBot"
  ) {
    this.client = client;
    this.config = { ...DEFAULT_FILLER_CONFIG, ...config };
    this.name = name;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // SlotSubscriber for accurate slot tracking
    this.slotSubscriber = new SlotSubscriber(this.client.connection);
    await this.slotSubscriber.subscribe();

    // UserMap for scanning all user accounts
    const connection = new Connection(
      config.solanaRpcUrl || this.client.connection.rpcEndpoint,
      "confirmed"
    );
    this.userMap = new UserMap({
      driftClient: this.client,
      connection,
      subscriptionConfig: {
        type: "polling",
        frequency: this.config.fillIntervalMs,
        commitment: "confirmed",
      },
      skipInitialLoad: false,
      includeIdle: false,
    } as any);
    await this.userMap.subscribe();

    // Priority fee subscriber
    this.priorityFeeSubscriber = new PriorityFeeSubscriber({
      connection,
      frequencyMs: 5_000,
      priorityFeeMethod: PriorityFeeMethod.HELIUS,
      heliusRpcUrl: config.heliusRpcUrl,
      addresses: [this.client.wallet.publicKey],
      priorityFeeMultiplier: 1.5,
      maxFeeMicroLamports: 100_000,
    });
    await this.priorityFeeSubscriber.subscribe();

    // Start fill loop
    this.intervalId = setInterval(
      () => this.runFillCycle(),
      this.config.fillIntervalMs
    );

    logger.info(`${this.name} started`, {
      markets: this.config.perpMarketIndices,
      intervalMs: this.config.fillIntervalMs,
      maxFillsPerCycle: this.config.maxFillsPerCycle,
      dryRun: this.config.dryRun,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.slotSubscriber?.unsubscribe();
    await this.userMap?.unsubscribe();
    await this.priorityFeeSubscriber?.unsubscribe();
    logger.info(`${this.name} stopped`, { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  // ── Fill Cycle (from keeper-bots-v2 filler.ts tryFill) ────────

  private async runFillCycle(): Promise<void> {
    if (this.tickInProgress || !this.running) return;
    this.tickInProgress = true;
    const start = Date.now();

    try {
      // Get DLOB snapshot
      const slot = this.slotSubscriber?.currentSlot || 0;
      const dlob = await this.userMap!.getDLOB(slot);

      let totalFills = 0;
      let totalTriggers = 0;

      for (const marketIndex of this.config.perpMarketIndices) {
        // 1. Process fillable perp nodes
        const fillCount = await this.tryFillPerpNodesForMarket(
          dlob,
          marketIndex,
          slot
        );
        totalFills += fillCount;

        if (totalFills >= this.config.maxFillsPerCycle) break;

        // 2. Process trigger orders
        const triggerCount = await this.tryTriggerOrdersForMarket(
          dlob,
          marketIndex,
          slot
        );
        totalTriggers += triggerCount;
      }

      // 3. Settle PnL if enabled
      if (this.config.settlePnl && totalFills > 0) {
        await this.settlePnls();
      }

      this.stats.cyclesCompleted++;
      this.stats.lastCycleDurationMs = Date.now() - start;

      if (totalFills > 0 || totalTriggers > 0) {
        logger.info(`${this.name}: cycle complete`, {
          fills: totalFills,
          triggers: totalTriggers,
          durationMs: this.stats.lastCycleDurationMs,
        });
      }
    } catch (err) {
      logger.warn(`${this.name}: fill cycle error`, { error: String(err) });
    } finally {
      this.tickInProgress = false;
    }
  }

  // ── Fill Perp Nodes (from keeper-bots-v2 tryFillPerpNodes) ────

  private async tryFillPerpNodesForMarket(
    dlob: DLOB,
    marketIndex: number,
    slot: number
  ): Promise<number> {
    const oraclePriceData =
      this.client.getOracleDataForPerpMarket(marketIndex);
    let fillCount = 0;

    // Get fillable nodes from DLOB
    const nodesToFill = (dlob as any).findNodesToFill(
      marketIndex,
      new BN(slot),
      MarketType.PERP,
      oraclePriceData,
      this.client.getStateAccount(),
      this.client.getPerpMarketAccount(marketIndex)!
    );

    for (const nodeToFill of nodesToFill) {
      if (fillCount >= this.config.maxFillsPerCycle) break;

      const nodeKey = this.getNodeKey(nodeToFill);
      if (this.isThrottled(nodeKey)) {
        this.stats.throttled++;
        continue;
      }

      try {
        const filled = await this.tryFillNode(nodeToFill, marketIndex);
        if (filled) {
          fillCount++;
          this.clearThrottle(nodeKey);
        } else {
          this.throttleNode(nodeKey);
        }
      } catch (err) {
        this.throttleNode(nodeKey);
        this.stats.fillsFailed++;
        logger.debug(`${this.name}: fill failed`, {
          marketIndex,
          error: String(err),
        });
      }
    }

    return fillCount;
  }

  // ── Single Node Fill ──────────────────────────────────────────

  private async tryFillNode(
    nodeToFill: NodeToFill,
    marketIndex: number
  ): Promise<boolean> {
    this.stats.fillsAttempted++;

    const node = nodeToFill.node;
    if (!node.order || !node.userAccount) return false;

    // Get maker infos from DLOB for multi-maker matching
    const makerInfos = await this.getMakerInfos(nodeToFill, marketIndex);

    if (this.config.dryRun) {
      logger.info(`${this.name}: dry-run fill`, {
        marketIndex,
        taker: node.userAccount.slice(0, 8),
        orderId: node.order.orderId,
        direction: getVariant(node.order.direction),
        baseAmount: convertToNumber(
          node.order.baseAssetAmount.sub(node.order.baseAssetAmountFilled),
          BASE_PRECISION
        ).toFixed(6),
        makerCount: makerInfos.length,
      });
      this.stats.fillsSucceeded++;
      return true;
    }

    try {
      const txParams = this.getTxParams();

      if (makerInfos.length > 0) {
        // Multi-maker fill: pass makers for optimal matching
        const txSig = await this.client.fillPerpOrder(
          node.userAccount as any,
          (await this.userMap!.mustGet(node.userAccount)).getUserAccount(),
          node.order,
          makerInfos,
          undefined,
          txParams
        );

        this.stats.fillsSucceeded++;
        logger.info(`${this.name}: multi-maker fill`, {
          txSig,
          marketIndex,
          orderId: node.order.orderId,
          makerCount: makerInfos.length,
        });
        return true;
      } else {
        // Single fill: let AMM fill
        const txSig = await this.client.fillPerpOrder(
          node.userAccount as any,
          (await this.userMap!.mustGet(node.userAccount)).getUserAccount(),
          node.order,
          undefined,
          undefined,
          txParams
        );

        this.stats.fillsSucceeded++;
        logger.info(`${this.name}: AMM fill`, {
          txSig,
          marketIndex,
          orderId: node.order.orderId,
        });
        return true;
      }
    } catch (err) {
      this.stats.fillsFailed++;
      const msg = err instanceof Error ? err.message : String(err);

      // Parse known errors (from keeper-bots-v2 txLogParse.ts)
      if (msg.includes("OrderDoesNotExist") || msg.includes("0x1781")) {
        // Order already filled or canceled — not a real error
        return false;
      }
      if (msg.includes("InsufficientCollateral") || msg.includes("0x17a0")) {
        logger.debug(`${this.name}: taker insufficient collateral`, {
          taker: node.userAccount?.slice(0, 8),
        });
        return false;
      }

      logger.warn(`${this.name}: fill error`, {
        marketIndex,
        orderId: node.order?.orderId,
        error: msg.slice(0, 200),
      });
      return false;
    }
  }

  // ── Trigger Orders (from keeper-bots-v2) ──────────────────────

  private async tryTriggerOrdersForMarket(
    dlob: DLOB,
    marketIndex: number,
    slot: number
  ): Promise<number> {
    const oraclePriceData =
      this.client.getOracleDataForPerpMarket(marketIndex);
    let triggerCount = 0;

    const nodesToTrigger = dlob.findNodesToTrigger(
      marketIndex,
      slot,
      oraclePriceData.price,
      MarketType.PERP,
      this.client.getStateAccount()
    );

    for (const nodeToTrigger of nodesToTrigger) {
      if (triggerCount >= this.config.maxTriggersPerCycle) break;

      const node = nodeToTrigger.node;
      if (!node.order || !node.userAccount) continue;

      this.stats.triggersAttempted++;

      if (this.config.dryRun) {
        logger.info(`${this.name}: dry-run trigger`, {
          marketIndex,
          orderId: node.order.orderId,
          triggerPrice: convertToNumber(
            node.order.triggerPrice,
            PRICE_PRECISION
          ).toFixed(4),
        });
        this.stats.triggersSucceeded++;
        triggerCount++;
        continue;
      }

      try {
        const userAccount = (
          await this.userMap!.mustGet(node.userAccount)
        ).getUserAccount();
        const txSig = await (this.client as any).triggerOrder(
          node.userAccount,
          userAccount,
          node.order,
          this.getTxParams()
        );

        this.stats.triggersSucceeded++;
        triggerCount++;
        logger.info(`${this.name}: triggered order`, {
          txSig,
          marketIndex,
          orderId: node.order.orderId,
        });
      } catch (err) {
        this.stats.triggersFailed++;
        logger.debug(`${this.name}: trigger failed`, {
          marketIndex,
          orderId: node.order?.orderId,
          error: String(err).slice(0, 200),
        });
      }
    }

    return triggerCount;
  }

  // ── PnL Settlement (from keeper-bots-v2) ──────────────────────

  private async settlePnls(): Promise<void> {
    try {
      const user = this.client.getUser();
      const perpPositions = user
        .getActivePerpPositions()
        .filter(
          (p) => !p.baseAssetAmount.isZero() || !p.quoteAssetAmount.isZero()
        );

      if (perpPositions.length === 0) return;

      const marketIndices = perpPositions.map((p) => p.marketIndex);
      const ixs = await this.client.getSettlePNLsIxs(
        [
          {
            settleeUserAccountPublicKey:
              await this.client.getUserAccountPublicKey(),
            settleeUserAccount: user.getUserAccount(),
          },
        ],
        marketIndices
      );

      if (ixs.length > 0) {
        const tx = await (this.client.txSender as any).getVersionedTransaction(
          ixs,
          [],
          this.client.wallet.publicKey
        );
        await (this.client.txSender as any).sendVersionedTransaction(
          tx,
          [],
          this.client.opts
        );
        this.stats.pnlSettlements++;
        logger.debug(`${this.name}: settled PnL`, {
          markets: marketIndices,
        });
      }
    } catch (err) {
      // Non-critical
      logger.debug(`${this.name}: PnL settlement failed`, {
        error: String(err),
      });
    }
  }

  // ── Maker Info Resolution (from keeper-bots-v2) ───────────────

  private async getMakerInfos(
    nodeToFill: NodeToFill,
    marketIndex: number
  ): Promise<MakerInfo[]> {
    if (!this.userMap) return [];

    const makerInfos: MakerInfo[] = [];
    try {
      // nodeToFill may include maker nodes
      const makerNodes = (nodeToFill as any).makerNodes;
      if (!makerNodes || makerNodes.length === 0) return [];

      for (const makerNode of makerNodes.slice(0, 4)) {
        if (!makerNode.userAccount) continue;
        const makerUser = await this.userMap.mustGet(makerNode.userAccount);
        const makerAuthority = makerUser.getUserAccount().authority;

        makerInfos.push({
          maker: makerUser.userAccountPublicKey,
          makerStats: getUserStatsAccountPublicKey(
            this.client.program.programId,
            makerAuthority
          ),
          makerUserAccount: makerUser.getUserAccount(),
          order: makerNode.order,
        });
      }
    } catch {
      // Fall back to no makers (AMM fill)
    }

    return makerInfos;
  }

  // ── Throttle Management (from keeper-bots-v2) ─────────────────

  private getNodeKey(nodeToFill: NodeToFill): string {
    const node = nodeToFill.node;
    return `${node.userAccount || "unknown"}-${node.order?.orderId || 0}`;
  }

  private isThrottled(key: string): boolean {
    const entry = this.throttledNodes.get(key);
    if (!entry) return false;

    if (Date.now() - entry.lastAttempt < this.config.throttleBackoffMs) {
      return true;
    }

    this.throttledNodes.delete(key);
    return false;
  }

  private throttleNode(key: string): void {
    const existing = this.throttledNodes.get(key);
    this.throttledNodes.set(key, {
      lastAttempt: Date.now(),
      consecutiveFailures: (existing?.consecutiveFailures || 0) + 1,
    });
  }

  private clearThrottle(key: string): void {
    this.throttledNodes.delete(key);
  }

  private getTxParams(): TxParams {
    const priorityFee =
      this.priorityFeeSubscriber?.getCustomStrategyResult() || 50_000;

    return {
      computeUnits: this.config.computeUnitsPerFill,
      computeUnitsPrice: Math.max(priorityFee, 50_000),
    };
  }
}
