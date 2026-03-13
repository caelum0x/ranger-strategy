import Decimal from "decimal.js";
import { CronJob } from "cron";
import { DriftManager } from "../drift/client";
import { BinanceManager } from "../binance/client";
import { RangerVaultManager } from "../ranger/client";
import { StrategyEngine } from "../strategy/engine";
import { config } from "../config";
import { logger } from "../utils/logger";

class StrategyAgent {
  private drift!: DriftManager;
  private binance!: BinanceManager;
  private ranger!: RangerVaultManager;
  private engine!: StrategyEngine;
  private rebalanceJob!: CronJob;
  private running = false;

  async start(): Promise<void> {
    logger.info("Starting AI Strategy Agent...");

    // Initialize Drift client
    // Supports keypair path (JSON file) or SOLANA_PRIVATE_KEY env var
    const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;

    this.drift = new DriftManager({ keypair: keypairSource });
    this.binance = new BinanceManager();

    // Ranger vault manager (admin + manager use same key for hackathon)
    const keypairBytes =
      typeof keypairSource === "string"
        ? new Uint8Array(
            JSON.parse(
              require("fs").readFileSync(keypairSource, "utf-8")
            )
          )
        : keypairSource;

    this.ranger = new RangerVaultManager(
      keypairBytes as Uint8Array,
      keypairBytes as Uint8Array
    );

    // Initialize all clients in parallel
    await Promise.all([
      this.drift.initialize(),
      this.binance.initialize(),
      this.ranger.initialize(),
    ]);

    // Set leverage on Binance (low leverage for delta-neutral)
    for (const asset of config.targetAssets) {
      await this.binance.setLeverage(asset, 2);
    }

    // Get initial capital from Binance
    const binanceBalance = await this.binance.getBalance();
    logger.info(`Binance balance: $${binanceBalance.toFixed(2)}`);

    // Check Drift account status
    const freeCollateral = this.drift.getFreeCollateral();
    logger.info(`Drift free collateral: $${freeCollateral.toFixed(2)}`);

    const initialCapital = binanceBalance.add(freeCollateral);
    logger.info(`Total initial capital: $${initialCapital.toFixed(2)}`);

    // Initialize strategy engine
    this.engine = new StrategyEngine(this.drift, this.binance, initialCapital);

    // Log initial market data
    await this.logMarketOverview();

    // Schedule rebalance cycles (every 8 hours aligned with funding)
    const intervalMinutes = config.rebalanceIntervalMs / 60000;
    this.rebalanceJob = new CronJob(
      `0 */${Math.max(1, Math.floor(intervalMinutes))} * * *`,
      () => this.runCycle(),
      null,
      false,
      "UTC"
    );

    this.running = true;
    this.rebalanceJob.start();

    // Run first cycle immediately
    await this.runCycle();

    logger.info("AI Strategy Agent started", {
      rebalanceInterval: `${intervalMinutes} minutes`,
      targetAssets: config.targetAssets,
      maxLeverage: config.maxLeverage.toString(),
      healthRatioFloor: config.healthRatioFloor.toString(),
      maxDrawdown: `${config.maxDrawdownPct.toString()}%`,
    });
  }

  private async logMarketOverview(): Promise<void> {
    try {
      // Fetch current funding rates from both venues
      const [driftRates, binanceRates] = await Promise.all([
        this.drift.getFundingRates(),
        this.binance.getFundingRates(),
      ]);

      logger.info("=== Market Overview ===");
      for (const asset of config.targetAssets) {
        const driftRate = driftRates.find((r) => r.asset === asset);
        const binanceRate = binanceRates.find((r) => r.asset === asset);
        const price = await this.drift.getOraclePrice(asset);

        logger.info(`${asset}:`, {
          price: `$${price.toFixed(2)}`,
          driftFundingAPY: driftRate
            ? `${driftRate.annualizedRate.mul(100).toFixed(2)}%`
            : "N/A",
          binanceFundingAPY: binanceRate
            ? `${binanceRate.annualizedRate.mul(100).toFixed(2)}%`
            : "N/A",
        });
      }

      // Fetch average funding rates from Data API
      const avgRates = await this.drift.getAverageFundingRates();
      logger.info("Drift average funding rates (Data API):", avgRates);
    } catch (err) {
      logger.warn("Could not fetch full market overview", { error: err });
    }
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;

    try {
      await this.engine.runCycle();

      // Log state for monitoring
      const state = this.engine.getState();
      logger.info("Agent cycle summary", {
        regime: state.regime,
        positions: state.positions.length,
        totalPnl: state.totalPnl.toFixed(4),
        healthRatio: state.healthRatio.toFixed(4),
        deployedCapital: state.deployedCapital.toFixed(2),
        idleCapital: state.idleCapital.toFixed(2),
        fundingPnl: this.drift.getUnrealizedFundingPnl().toFixed(4),
        freeCollateral: this.drift.getFreeCollateral().toFixed(2),
      });
    } catch (err) {
      logger.error("Strategy cycle failed", { error: err });
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping AI Strategy Agent...");
    this.running = false;

    if (this.rebalanceJob) {
      this.rebalanceJob.stop();
    }

    // Emergency unwind before stopping
    if (this.engine) {
      await this.engine.emergencyUnwind();
    }

    await Promise.all([this.drift.shutdown(), this.binance.shutdown()]);

    logger.info("AI Strategy Agent stopped");
  }

  getStatus(): object {
    if (!this.engine) return { status: "not initialized" };

    const state = this.engine.getState();
    return {
      status: this.running ? "running" : "stopped",
      regime: state.regime,
      totalCapital: state.totalCapital.toFixed(2),
      deployedCapital: state.deployedCapital.toFixed(2),
      idleCapital: state.idleCapital.toFixed(2),
      totalPnl: state.totalPnl.toFixed(4),
      healthRatio: state.healthRatio.toFixed(4),
      fundingPnl: this.drift.getUnrealizedFundingPnl().toFixed(4),
      freeCollateral: this.drift.getFreeCollateral().toFixed(2),
      leverage: this.drift.getLeverage
        ? "see positions"
        : "N/A",
      positions: state.positions.map((p) => ({
        asset: p.asset,
        side: p.side,
        venue: p.venue,
        size: p.size.toFixed(6),
        notional: p.notionalValue.toFixed(2),
        pnl: p.unrealizedPnl.toFixed(4),
      })),
      lastRebalance: new Date(state.lastRebalance).toISOString(),
    };
  }
}

// ── Entry point ──────────────────────────────────────────────────────

async function main() {
  const agent = new StrategyAgent();

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await agent.start();

  // Keep process alive
  logger.info("Agent running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.error("Agent fatal error", { error: err });
  process.exit(1);
});
