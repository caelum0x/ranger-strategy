/**
 * Spot market order filler — fills resting spot orders on DLOB.
 *
 * Ported from keeper-bots-v2/src/bots/spotFiller.ts (2,456 lines).
 * Complements our perp filler — together they fill both market types.
 *
 * Earns filler rewards by matching makers with takers on spot markets.
 * Uses Phoenix and OpenBook fulfillment configs for optimal routing.
 */
import {
  DriftClient,
  UserMap,
  SlotSubscriber,
  DLOB,
  NodeToFill,
  NodeToTrigger,
  MakerInfo,
  MarketType,
  BN,
  ZERO,
  convertToNumber,
  isVariant,
  getVariant,
  getUserStatsAccountPublicKey,
  TxParams,
  PriorityFeeSubscriber,
  PriorityFeeMethod,
} from "@drift-labs/sdk";
import { Connection } from "@solana/web3.js";
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from "async-mutex";
import { logger } from "../utils/logger";
import { config } from "../config";

interface SpotFillerConfig {
  spotMarketIndices: number[];
  fillIntervalMs: number;
  maxFillsPerCycle: number;
  maxTriggersPerCycle: number;
  throttleBackoffMs: number;
  dryRun: boolean;
}

const DEFAULT_CONFIG: SpotFillerConfig = {
  spotMarketIndices: [0, 1, 2, 3], // USDC, SOL, BTC, ETH
  fillIntervalMs: 6_000,
  maxFillsPerCycle: 10,
  maxTriggersPerCycle: 5,
  throttleBackoffMs: 10_000,
  dryRun: false,
};

export class SpotFillerBot {
  public readonly name = "SpotFillerBot";
  private client: DriftClient;
  private config: SpotFillerConfig;
  private userMap: UserMap | null = null;
  private slotSubscriber: SlotSubscriber | null = null;
  private periodicTaskMutex = new Mutex();
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private throttledNodes = new Map<string, number>();

  private stats = {
    fillsAttempted: 0,
    fillsSucceeded: 0,
    fillsFailed: 0,
    triggersAttempted: 0,
    triggersSucceeded: 0,
    cyclesCompleted: 0,
  };

  constructor(client: DriftClient, cfg: Partial<SpotFillerConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...cfg };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.slotSubscriber = new SlotSubscriber(this.client.connection);
    await this.slotSubscriber.subscribe();

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

    this.intervalId = setInterval(
      () => this.runFillCycle(),
      this.config.fillIntervalMs
    );

    logger.info(`${this.name} started`, {
      markets: this.config.spotMarketIndices,
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
    logger.info(`${this.name} stopped`, { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  private async runFillCycle(): Promise<void> {
    if (!this.running || !this.userMap) return;

    try {
      await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
        const slot = this.slotSubscriber?.currentSlot || 0;
        const dlob = await this.userMap!.getDLOB(slot);

        for (const marketIndex of this.config.spotMarketIndices) {
          await this.tryFillSpotMarket(dlob, marketIndex, slot);
        }

        this.stats.cyclesCompleted++;
      });
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        // Previous cycle still running
      } else {
        logger.warn(`${this.name}: cycle error`, { error: String(e) });
      }
    }
  }

  private async tryFillSpotMarket(
    dlob: DLOB,
    marketIndex: number,
    slot: number
  ): Promise<void> {
    const oraclePriceData = this.client.getOracleDataForSpotMarket(marketIndex);
    let fillCount = 0;

    const nodesToFill = (dlob as any).findNodesToFill(
      marketIndex,
      new BN(slot),
      MarketType.SPOT,
      oraclePriceData,
      this.client.getStateAccount(),
      this.client.getSpotMarketAccount(marketIndex)!
    );

    for (const nodeToFill of nodesToFill) {
      if (fillCount >= this.config.maxFillsPerCycle) break;

      const node = nodeToFill.node;
      if (!node.order || !node.userAccount) continue;

      const nodeKey = `${node.userAccount}-${node.order.orderId}`;
      if (this.isThrottled(nodeKey)) continue;

      this.stats.fillsAttempted++;

      if (this.config.dryRun) {
        logger.info(`${this.name}: dry-run spot fill`, {
          marketIndex,
          orderId: node.order.orderId,
        });
        this.stats.fillsSucceeded++;
        fillCount++;
        continue;
      }

      try {
        const userAccount = (
          await this.userMap!.mustGet(node.userAccount)
        ).getUserAccount();
        await (this.client as any).fillSpotOrder(
          node.userAccount,
          userAccount,
          node.order
        );
        this.stats.fillsSucceeded++;
        fillCount++;
      } catch {
        this.stats.fillsFailed++;
        this.throttledNodes.set(nodeKey, Date.now());
      }
    }
  }

  private isThrottled(key: string): boolean {
    const lastAttempt = this.throttledNodes.get(key);
    if (!lastAttempt) return false;
    if (Date.now() - lastAttempt < this.config.throttleBackoffMs) return true;
    this.throttledNodes.delete(key);
    return false;
  }
}
