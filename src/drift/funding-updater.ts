/**
 * Funding Rate Updater — cranks funding rate updates on Drift.
 *
 * Ported from keeper-bots-v2/src/bots/fundingRateUpdater.ts (389 lines).
 * Funding rates on Drift need to be "cranked" (updated) periodically.
 * By cranking them ourselves, we ensure they're fresh for our strategy
 * and earn keeper incentives.
 *
 * Also useful: stale funding rates can cause bad strategy decisions.
 */
import {
  DriftClient,
  BN,
  ZERO,
} from "@drift-labs/sdk";
import { logger } from "../utils/logger";

interface FundingUpdaterConfig {
  perpMarketIndices: number[];
  updateIntervalMs: number;
}

const DEFAULT_CONFIG: FundingUpdaterConfig = {
  perpMarketIndices: [0, 1, 2], // SOL, BTC, ETH
  updateIntervalMs: 60_000, // every minute
};

export class FundingRateUpdater {
  public readonly name = "FundingRateUpdater";
  private client: DriftClient;
  private config: FundingUpdaterConfig;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private stats = {
    updatesAttempted: 0,
    updatesSucceeded: 0,
    cyclesCompleted: 0,
  };

  constructor(client: DriftClient, cfg: Partial<FundingUpdaterConfig> = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...cfg };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.intervalId = setInterval(
      () => this.runUpdateCycle(),
      this.config.updateIntervalMs
    );

    logger.info(`${this.name} started`, {
      markets: this.config.perpMarketIndices,
      intervalMs: this.config.updateIntervalMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info(`${this.name} stopped`, { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  /**
   * Crank funding rate updates for all configured markets.
   * From: keeper-bots-v2/src/bots/fundingRateUpdater.ts
   *
   * This calls Drift's updateFundingRate instruction which:
   * 1. Calculates current mark-oracle spread
   * 2. Updates the TWAP
   * 3. Computes new funding rate
   */
  private async runUpdateCycle(): Promise<void> {
    if (!this.running) return;

    for (const marketIndex of this.config.perpMarketIndices) {
      try {
        this.stats.updatesAttempted++;

        const perpMarket = this.client.getPerpMarketAccount(marketIndex);
        if (!perpMarket) continue;

        // Check if funding rate update is needed
        // Drift updates funding every hour, but we crank it to ensure freshness
        const lastFundingTs = perpMarket.amm.lastFundingRateTs.toNumber();
        const now = Math.floor(Date.now() / 1000);
        const timeSinceUpdate = now - lastFundingTs;

        // Only crank if it's been more than 55 minutes (almost due for update)
        if (timeSinceUpdate < 3300) continue; // 55 minutes

        const oracleData = this.client.getOracleDataForPerpMarket(marketIndex);

        await (this.client as any).updateFundingRate(
          marketIndex,
          oracleData.price
        );

        this.stats.updatesSucceeded++;
        logger.debug(`${this.name}: updated funding rate`, {
          marketIndex,
          timeSinceLastUpdate: `${Math.floor(timeSinceUpdate / 60)}m`,
        });
      } catch {
        // Non-critical — someone else may have cranked it
      }
    }

    this.stats.cyclesCompleted++;
  }
}
