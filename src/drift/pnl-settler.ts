/**
 * PnL Settler — settles unrealized PnL for users on Drift.
 *
 * Ported from keeper-bots-v2/src/bots/userPnlSettler.ts (1,726 lines).
 * Settling PnL is important because:
 *   - Unrealized PnL doesn't count toward free collateral
 *   - Regular settlement improves capital efficiency
 *   - Earns keeper incentives on some markets
 *
 * Used by: strategy engine (settles own PnL) + standalone keeper mode.
 */
import {
  DriftClient,
  UserMap,
  BN,
  ZERO,
  convertToNumber,
  PRICE_PRECISION,
  isVariant,
} from "@drift-labs/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { config } from "../config";

interface PnlSettlerConfig {
  perpMarketIndices: number[];
  settlementIntervalMs: number;
  maxSettlementsPerCycle: number;
  minPnlToSettle: number; // in USDC, skip dust
}

const DEFAULT_CONFIG: PnlSettlerConfig = {
  perpMarketIndices: [0, 1, 2], // SOL, BTC, ETH
  settlementIntervalMs: 30_000, // every 30 seconds
  maxSettlementsPerCycle: 20,
  minPnlToSettle: 0.01, // $0.01 minimum
};

export class PnlSettler {
  public readonly name = "PnlSettler";
  private client: DriftClient;
  private config: PnlSettlerConfig;
  private userMap: UserMap | null = null;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private stats = {
    settlementsAttempted: 0,
    settlementsSucceeded: 0,
    totalPnlSettled: 0,
    cyclesCompleted: 0,
  };

  constructor(client: DriftClient, cfg: Partial<PnlSettlerConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...cfg };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const connection = new Connection(
      config.solanaRpcUrl || this.client.connection.rpcEndpoint,
      "confirmed"
    );
    this.userMap = new UserMap({
      driftClient: this.client,
      connection,
      subscriptionConfig: {
        type: "polling",
        frequency: this.config.settlementIntervalMs,
        commitment: "confirmed",
      },
      skipInitialLoad: false,
      includeIdle: false,
    } as any);
    await this.userMap.subscribe();

    this.intervalId = setInterval(
      () => this.runSettlementCycle(),
      this.config.settlementIntervalMs
    );

    logger.info(`${this.name} started`, {
      markets: this.config.perpMarketIndices,
      intervalMs: this.config.settlementIntervalMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.userMap?.unsubscribe();
    logger.info(`${this.name} stopped`, { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  /**
   * Settle PnL for our own account (called by strategy engine).
   */
  async settleOwnPnl(marketIndices: number[]): Promise<void> {
    try {
      const user = this.client.getUser();
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
        this.stats.settlementsSucceeded++;
        logger.debug("Settled own PnL", { markets: marketIndices });
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Settle PnL for other users (keeper mode — earns incentives).
   * From: keeper-bots-v2/src/bots/userPnlSettler.ts
   */
  private async runSettlementCycle(): Promise<void> {
    if (!this.running || !this.userMap) return;

    let settledCount = 0;
    try {
      for (const marketIndex of this.config.perpMarketIndices) {
        const usersToSettle = this.findUsersWithUnsettledPnl(marketIndex);

        for (const userEntry of usersToSettle.slice(
          0,
          this.config.maxSettlementsPerCycle - settledCount
        )) {
          if (settledCount >= this.config.maxSettlementsPerCycle) break;

          try {
            this.stats.settlementsAttempted++;

            const ixs = await this.client.getSettlePNLsIxs(
              [
                {
                  settleeUserAccountPublicKey: userEntry.userAccountPublicKey,
                  settleeUserAccount: userEntry.userAccount,
                },
              ],
              [marketIndex]
            );

            if (ixs.length > 0) {
              const tx = await (
                this.client.txSender as any
              ).getVersionedTransaction(
                ixs,
                [],
                this.client.wallet.publicKey
              );
              await (
                this.client.txSender as any
              ).sendVersionedTransaction(tx, [], this.client.opts);

              this.stats.settlementsSucceeded++;
              settledCount++;
            }
          } catch {
            // Skip this user, try next
          }
        }
      }

      this.stats.cyclesCompleted++;
    } catch (err) {
      logger.debug(`${this.name}: cycle error`, { error: String(err) });
    }
  }

  private findUsersWithUnsettledPnl(
    marketIndex: number
  ): Array<{
    userAccountPublicKey: PublicKey;
    userAccount: any;
    unsettledPnl: number;
  }> {
    const results: Array<{
      userAccountPublicKey: PublicKey;
      userAccount: any;
      unsettledPnl: number;
    }> = [];

    if (!this.userMap) return results;

    for (const user of this.userMap.values()) {
      const perpPos = user.getPerpPosition(marketIndex);
      if (!perpPos) continue;

      const unsettledPnl = convertToNumber(
        perpPos.quoteAssetAmount,
        PRICE_PRECISION
      );
      if (Math.abs(unsettledPnl) > this.config.minPnlToSettle) {
        results.push({
          userAccountPublicKey: user.userAccountPublicKey,
          userAccount: user.getUserAccount(),
          unsettledPnl,
        });
      }
    }

    // Sort by absolute PnL descending (settle biggest first)
    results.sort((a, b) => Math.abs(b.unsettledPnl) - Math.abs(a.unsettledPnl));
    return results;
  }
}
