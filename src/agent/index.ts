import { CronJob } from "cron";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import { DriftManager } from "../drift/client";
import { DriftFundingAnalyzer } from "../drift/funding";
import { DriftExecutor } from "../drift/executor";
import { DriftVaultManager } from "../drift/vault";
import { BinanceManager } from "../binance/client";
import { RangerVaultManager } from "../ranger/client";
import { StrategyEngine } from "../strategy/engine";
import { config } from "../config";
import { logger } from "../utils/logger";
import { validateConfig } from "../utils/validate";
import { YieldAnalytics } from "../utils/yield-analytics";
import { MonitorServer } from "../monitor/server";
import { StateStore } from "../utils/state-store";
import { TelegramAlerter } from "../alerts/telegram";
import { StrategyAdvisor } from "../ai/strategy-advisor";
import { OpenRouterClient } from "../ai/openrouter";
import { TradeLogger } from "../utils/trade-logger";
import { VaultPerformanceTracker } from "../vault/performance";

class StrategyAgent {
  private drift!: DriftManager;
  private binance: BinanceManager | null = null;
  private ranger!: RangerVaultManager;
  private engine!: StrategyEngine;
  private fundingAnalyzer!: DriftFundingAnalyzer;
  private executor!: DriftExecutor;
  private driftVault!: DriftVaultManager;
  private rebalanceJob!: CronJob;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private yieldAnalytics: YieldAnalytics = new YieldAnalytics();
  private monitor: MonitorServer = new MonitorServer(
    parseInt(process.env.MONITOR_PORT || "3000")
  );
  private stateStore: StateStore = new StateStore();
  private tradeLogger: TradeLogger = new TradeLogger();
  private vaultPerf: VaultPerformanceTracker = new VaultPerformanceTracker();
  private telegram: TelegramAlerter = new TelegramAlerter();
  private running = false;

  async start(): Promise<void> {
    logger.info("Starting AI Strategy Agent...", {
      mode: config.strategyMode,
    });

    // Validate config before proceeding
    const configCheck = validateConfig();
    if (!configCheck.valid) {
      throw new Error(
        `Configuration invalid: ${configCheck.errors.join("; ")}`
      );
    }

    // Initialize Drift client
    const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;

    this.drift = new DriftManager({ keypair: keypairSource });

    const loadKeypairBytes = (pathOrKey: string | Uint8Array): Uint8Array =>
      typeof pathOrKey === "string"
        ? new Uint8Array(
            JSON.parse(require("fs").readFileSync(pathOrKey, "utf-8"))
          )
        : pathOrKey;

    const adminKeypairSource =
      process.env.ADMIN_KEYPAIR_PATH || process.env.ANCHOR_WALLET || config.solanaPrivateKey;
    const managerKeypairSource =
      process.env.MANAGER_KEYPAIR_PATH || adminKeypairSource;

    this.ranger = new RangerVaultManager(
      loadKeypairBytes(adminKeypairSource),
      loadKeypairBytes(managerKeypairSource)
    );

    // Initialize clients — Binance only needed in cross-venue mode
    const initPromises: Promise<void>[] = [
      this.drift.initialize(),
      this.ranger.initialize(),
    ];

    if (config.strategyMode === "cross-venue") {
      this.binance = new BinanceManager();
      initPromises.push(this.binance.initialize());
    } else {
      logger.info(
        "Drift-only mode: all capital stays on-chain (no Binance required)"
      );
    }

    await Promise.all(initPromises);

    // Set leverage on Binance if active
    if (this.binance) {
      for (const asset of config.targetAssets) {
        await this.binance.setLeverage(asset, 2);
      }
    }

    // Calculate initial capital
    let initialCapital = this.drift.getFreeCollateral();
    logger.info(`Drift free collateral: $${initialCapital.toFixed(2)}`);

    if (this.binance) {
      const binanceBalance = await this.binance.getBalance();
      logger.info(`Binance balance: $${binanceBalance.toFixed(2)}`);
      initialCapital = initialCapital.add(binanceBalance);
    }

    logger.info(`Total initial capital: $${initialCapital.toFixed(2)}`);

    // Initialize strategy engine (Binance is null in drift-only mode)
    this.engine = new StrategyEngine(
      this.drift,
      this.binance,
      initialCapital
    );

    // Restore state from previous run if available (crash recovery)
    const savedState = this.stateStore.load();
    if (savedState) {
      this.engine.restoreState(savedState.state);
      this.engine.restorePredictorHistory(savedState.predictorHistory);
      if (savedState.startTime) {
        this.engine.setStartTime(savedState.startTime);
      }
      logger.info("Resumed from saved state", {
        savedAt: new Date(savedState.savedAt).toISOString(),
        cycle: savedState.state.cycleCount,
      });
    }

    // Start monitoring server
    this.setupMonitorRoutes();
    await this.monitor.start();

    // Wire up on-chain funding analyzer and atomic executor
    const driftClient = this.drift.getClient();
    if (driftClient) {
      this.fundingAnalyzer = new DriftFundingAnalyzer(driftClient);
      this.executor = new DriftExecutor(driftClient);
      this.engine.setFundingAnalyzer(this.fundingAnalyzer);
      this.engine.setExecutor(this.executor);
      logger.info("On-chain funding analyzer and executor attached");

      // Wire LLM strategy advisor if API key is available
      if (config.openRouterApiKey) {
        try {
          const llmClient = new OpenRouterClient(
            config.openRouterApiKey,
            config.llmModel
          );
          const advisor = new StrategyAdvisor(llmClient);
          this.engine.setAdvisor(advisor);
          logger.info("LLM Strategy Advisor attached", {
            model: config.llmModel,
          });
        } catch (err: any) {
          logger.warn("LLM advisor not available — using EMA predictor", {
            error: err.message,
          });
        }
      }

      // Initialize Drift Vault Manager if vault address is configured.
      // When a vault is configured, create a second DriftManager that trades
      // as the vault's delegate — orders go through the vault's Drift user account.
      const driftVaultPubkey = process.env.DRIFT_VAULT_PUBKEY;
      if (driftVaultPubkey) {
        this.driftVault = new DriftVaultManager(
          driftClient,
          this.drift.getWallet()
        );
        await this.driftVault.initialize();
        const vaultAddress = new PublicKey(driftVaultPubkey);

        // Get delegate config (vault PDA as authority)
        const delegateConfig =
          await this.driftVault.getDelegateConfig(vaultAddress);
        logger.info("Vault delegate config", {
          authority: delegateConfig.authority.toBase58(),
          subAccountIds: delegateConfig.subAccountIds,
        });

        // Re-initialize Drift client for delegated trading on the vault
        const vaultDrift = new DriftManager({
          keypair: keypairSource,
          delegateFor: delegateConfig,
        });
        await vaultDrift.initialize();

        // Swap out the agent's drift client so all trades go through the vault
        const oldDrift = this.drift;
        this.drift = vaultDrift;

        // Re-wire executor and funding analyzer to the new delegated client
        const vaultDriftClient = vaultDrift.getClient();
        this.fundingAnalyzer = new DriftFundingAnalyzer(vaultDriftClient);
        this.executor = new DriftExecutor(vaultDriftClient);

        // Re-wire the strategy engine to use the delegated client
        this.engine.setDrift(this.drift);
        this.engine.setFundingAnalyzer(this.fundingAnalyzer);
        this.engine.setExecutor(this.executor);

        const equity = await this.driftVault.getVaultEquity(vaultAddress);
        logger.info("Drift Vault connected — trading as delegate", {
          vault: driftVaultPubkey,
          equity: `$${equity.toFixed(2)}`,
        });

        // Shut down the old non-delegated client
        await oldDrift.shutdown();
      }
    }

    // Log initial market data
    await this.logMarketOverview();

    // Schedule rebalance cycles (every 8 hours aligned with funding)
    const intervalHours = Math.max(1, Math.round(config.rebalanceIntervalMs / 3600000));
    this.rebalanceJob = new CronJob(
      `0 */${intervalHours} * * *`,
      () => this.runCycle(),
      null,
      false,
      "UTC"
    );

    this.running = true;
    this.rebalanceJob.start();

    // Health monitoring: poll every 2 minutes between cycles to catch
    // rapid health deterioration and trigger emergency unwind
    this.healthCheckInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        const health = await this.drift.getHealthRatio();
        if (health.lt(new Decimal("1.05"))) {
          logger.error(
            `CRITICAL: Health ratio ${health.toFixed(4)} — triggering emergency unwind`
          );
          this.telegram
            .emergencyAlert(`Health ratio ${health.toFixed(4)} below critical threshold 1.05`)
            .catch(() => {});
          await this.engine.emergencyUnwind();
        } else if (health.lt(new Decimal("1.20"))) {
          logger.warn(`Health ratio warning: ${health.toFixed(4)}`);
        }
      } catch {
        // Non-critical — health check failure shouldn't crash the agent
      }
    }, 120_000); // every 2 minutes

    // Run first cycle immediately
    await this.runCycle();

    logger.info("AI Strategy Agent started", {
      mode: config.strategyMode,
      rebalanceInterval: `${intervalHours} hours`,
      targetAssets: config.targetAssets,
      maxLeverage: config.maxLeverage.toString(),
      healthRatioFloor: config.healthRatioFloor.toString(),
      maxDrawdown: `${config.maxDrawdownPct.toString()}%`,
      minFundingAPY: `${config.minFundingAPY.toString()}`,
    });
  }

  private setupMonitorRoutes(): void {
    this.monitor.route("/", () => ({
      name: "Ranger Delta-Neutral Vault Agent",
      version: "0.1.0",
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      endpoints: ["/status", "/positions", "/yield", "/predictions", "/reasoning", "/trades", "/vault", "/health"],
    }));

    this.monitor.route("/status", () => this.getStatus());

    this.monitor.route("/positions", () => {
      if (!this.engine) return { positions: [] };
      const state = this.engine.getState();
      return {
        count: state.positions.length,
        positions: state.positions.map((p) => ({
          asset: p.asset,
          side: p.side,
          venue: p.venue,
          size: p.size.toFixed(6),
          entryPrice: p.entryPrice.toFixed(2),
          currentPrice: p.currentPrice.toFixed(2),
          notional: p.notionalValue.toFixed(2),
          pnl: p.unrealizedPnl.toFixed(4),
          leverage: p.leverage.toFixed(2),
        })),
      };
    });

    this.monitor.route("/yield", () => {
      if (!this.engine) return { error: "Not initialized" };
      const state = this.engine.getState();
      const breakdown = this.yieldAnalytics.calculateBreakdown(state);
      const formatted = this.yieldAnalytics.formatBreakdown(breakdown);
      const trend = this.yieldAnalytics.getYieldTrend();
      const attribution = this.yieldAnalytics.calculateAssetAttribution(
        state.positions,
        new Map<string, Decimal>()
      );
      return {
        ...formatted,
        trend,
        assetAttribution: attribution.map((a) => ({
          asset: a.asset,
          direction: a.fundingDirection,
          spotSide: a.spotSide,
          notional: a.notionalValue.toFixed(2),
          dailyYield: a.estimatedDailyYield.toFixed(4),
          annualYield: a.estimatedAnnualYield.toFixed(4),
        })),
      };
    });

    this.monitor.route("/predictions", () => {
      if (!this.engine) return { predictions: [] };
      const state = this.engine.getState();
      const reasoning = this.engine.getLastReasoning();
      return {
        regime: state.regime,
        source: reasoning ? "LLM" : "EMA",
        predictions: config.targetAssets.map((asset) => {
          const histLen = this.engine
            ? this.engine.getPredictorHistory().get(asset)?.length || 0
            : 0;
          return { asset, historyLength: histLen };
        }),
        reasoning: reasoning || null,
      };
    });

    this.monitor.route("/reasoning", () => {
      if (!this.engine) return { reasoning: null };
      return {
        reasoning: this.engine.getLastReasoning() || "No LLM analysis available yet",
      };
    });

    this.monitor.route("/trades", () => ({
      summary: this.tradeLogger.getSummary(),
      recentEvents: this.tradeLogger.readRecent(20),
    }));

    this.monitor.route("/vault", () => {
      const report = this.vaultPerf.generateReport();
      return this.vaultPerf.formatReport(report);
    });

    this.monitor.route("/health", () => {
      if (!this.engine) return { healthy: false, reason: "Not initialized" };
      const state = this.engine.getState();
      const healthy = state.healthRatio.gt(1.1);
      const capitalUtilization = state.totalCapital.gt(0)
        ? state.deployedCapital.div(state.totalCapital)
        : new Decimal(0);
      const healthScore = MonitorServer.calculateHealthScore({
        healthRatio: state.healthRatio,
        drawdownPct: state.currentDrawdown,
        deltaImbalance: new Decimal(0),
        capitalUtilization,
      });
      return {
        healthy,
        healthScore: healthScore.score,
        grade: healthScore.grade,
        healthRatio: state.healthRatio.toFixed(4),
        drawdown: state.currentDrawdown.toFixed(2),
        regime: state.regime,
        cycle: state.cycleCount,
      };
    });
  }

  private startTime = Date.now();

  private async logMarketOverview(): Promise<void> {
    try {
      // Fetch current funding rates
      const driftRates = await this.drift.getFundingRates();
      const binanceRates = this.binance
        ? await this.binance.getFundingRates()
        : [];

      logger.info("=== Market Overview ===");
      for (const asset of config.targetAssets) {
        const driftRate = driftRates.find((r) => r.asset === asset);
        const binanceRate = binanceRates.find((r) => r.asset === asset);
        const price = await this.drift.getOraclePrice(asset);

        const rateInfo: Record<string, string> = {
          price: `$${price.toFixed(2)}`,
          driftFundingAPY: driftRate
            ? `${driftRate.annualizedRate.mul(100).toFixed(2)}%`
            : "N/A",
        };
        if (binanceRate) {
          rateInfo.binanceFundingAPY = `${binanceRate.annualizedRate.mul(100).toFixed(2)}%`;
        }

        logger.info(`${asset}:`, rateInfo);
      }

      // On-chain funding analysis with premium, imbalance, and momentum
      if (this.fundingAnalyzer) {
        const analyses = this.fundingAnalyzer.analyzeAllAssets();
        logger.info("=== On-Chain Funding Analysis ===");
        for (const a of analyses) {
          logger.info(`${a.asset} on-chain:`, {
            annualized: `${a.annualizedRate.mul(100).toFixed(2)}%`,
            premium: `${a.premium.mul(100).toFixed(4)}%`,
            imbalance: `${a.longShortImbalance.mul(100).toFixed(2)}%`,
            predicted: a.predictedDirection,
            confidence: `${a.confidence.mul(100).toFixed(0)}%`,
            attractive: a.isAttractive,
            direction: a.attractiveDirection || "none",
            momentum: a.momentum,
          });
        }
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
      const summary: Record<string, string> = {
        mode: config.strategyMode,
        cycle: state.cycleCount.toString(),
        regime: state.regime,
        positions: state.positions.length.toString(),
        totalPnl: state.totalPnl.toFixed(4),
        healthRatio: state.healthRatio.toFixed(4),
        deployedCapital: state.deployedCapital.toFixed(2),
        idleCapital: state.idleCapital.toFixed(2),
        fundingPnl: this.drift.getUnrealizedFundingPnl().toFixed(4),
        fundingCollected: state.totalFundingCollected.toFixed(4),
        lendingCollected: state.totalLendingCollected.toFixed(4),
        tradingCosts: state.totalTradingCosts.toFixed(4),
        directionFlips: state.directionFlips.toString(),
        freeCollateral: this.drift.getFreeCollateral().toFixed(2),
        apyEstimate: `${state.apyEstimate.toFixed(2)}%`,
      };

      // Include vault equity + withdrawal risk monitoring if available
      if (this.driftVault && process.env.DRIFT_VAULT_PUBKEY) {
        try {
          const vaultAddr = new PublicKey(process.env.DRIFT_VAULT_PUBKEY);
          const equity = await this.driftVault.getVaultEquity(vaultAddr);
          summary.vaultEquity = `$${equity.toFixed(2)}`;

          // Apply profit share to all depositors
          try {
            await this.driftVault.applyProfitShareToAll(vaultAddr);
            logger.info("Profit share applied to depositors");
          } catch {
            // Non-critical — may fail if no profit to distribute
          }

          // Check if outstanding withdrawals could trigger liquidation takeover
          const risk = await this.driftVault.checkWithdrawalRisk(vaultAddr);

          // Pass pending withdrawals to engine for liquidity-aware position sizing
          this.engine.setPendingWithdrawals(risk.totalWithdrawRequested);

          if (risk.atRisk) {
            logger.error(
              "VAULT WITHDRAWAL RISK: reduce positions before redemption",
              {
                withdrawRequested: `$${risk.totalWithdrawRequested.toFixed(2)}`,
                equity: `$${risk.vaultEquity.toFixed(2)}`,
                ratio: `${risk.withdrawRatio.mul(100).toFixed(1)}%`,
              }
            );
            // Act on withdrawal risk — reduce positions to ensure redemption
            await this.engine.reducePositions();
          }
        } catch {
          /* non-critical */
        }
      }

      // Yield analytics breakdown
      const yieldBreakdown = this.yieldAnalytics.calculateBreakdown(state);
      const formatted = this.yieldAnalytics.formatBreakdown(yieldBreakdown);
      summary.yieldNetYield = formatted.netYield;
      summary.yieldAPY = formatted.annualizedAPY;
      summary.capitalUtilization = formatted.capitalUtilization;

      const trend = this.yieldAnalytics.getYieldTrend();
      summary.yieldTrend = trend.direction;

      // Record NAV snapshot for vault performance tracking
      let vaultPendingWithdrawals = new Decimal(0);
      let vaultTotalShares = new Decimal(0);
      let vaultDepositorCount = 0;
      let vaultManagerFees = new Decimal(0);

      if (this.driftVault && process.env.DRIFT_VAULT_PUBKEY) {
        try {
          const vaultAddr = new PublicKey(process.env.DRIFT_VAULT_PUBKEY);
          const vaultInfo = await this.driftVault.getVault(vaultAddr);
          vaultPendingWithdrawals = new Decimal(vaultInfo.totalWithdrawRequested.toString()).div(1e6);
          vaultTotalShares = new Decimal(vaultInfo.totalShares.toString());
          vaultManagerFees = new Decimal(vaultInfo.managerTotalFee.toString()).div(1e6);
          const depositors = await this.driftVault.getDepositors(vaultAddr);
          vaultDepositorCount = depositors.length;
        } catch {
          // Non-critical — vault info may not be available
        }
      }

      this.vaultPerf.recordSnapshot(state, {
        pendingWithdrawals: vaultPendingWithdrawals,
        totalShares: vaultTotalShares,
        depositorCount: vaultDepositorCount,
        managerFees: vaultManagerFees,
      });

      logger.info("Agent cycle summary", summary);

      // Send Telegram cycle summary with LLM reasoning (non-blocking)
      const llmReasoning = this.engine.getLastReasoning();
      this.telegram
        .cycleSummary({
          cycle: state.cycleCount,
          regime: state.regime,
          pnl: state.totalPnl.toFixed(4),
          apy: `${state.apyEstimate.toFixed(2)}%`,
          health: state.healthRatio.toFixed(4),
          positions: state.positions.length,
          funding: `$${state.totalFundingCollected.toFixed(4)}`,
          reasoning: llmReasoning || undefined,
        })
        .catch(() => {});

      // Persist state to disk for crash recovery
      this.stateStore.save(
        state,
        state.totalCapital.add(state.totalPnl), // approximate peak equity
        this.engine.getPredictorHistory(),
        this.engine.getStartTime()
      );
    } catch (err) {
      logger.error("Strategy cycle failed", { error: err });
    }
  }

  /**
   * Graceful shutdown — saves state and stops the cron, but keeps positions open.
   * Positions persist on-chain and will be managed on next restart.
   * Use emergencyStop() to unwind all positions before shutting down.
   */
  async stop(): Promise<void> {
    logger.info("Stopping AI Strategy Agent (graceful — positions kept open)...");
    this.running = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.rebalanceJob) {
      this.rebalanceJob.stop();
    }

    // Save final state to disk so next restart can resume
    if (this.engine) {
      const state = this.engine.getState();
      this.stateStore.save(
        state,
        state.totalCapital.add(state.totalPnl),
        this.engine.getPredictorHistory(),
        this.engine.getStartTime()
      );
      logger.info("Final state saved to disk", {
        cycle: state.cycleCount,
        positions: state.positions.length,
        funding: state.totalFundingCollected.toFixed(4),
      });
    }

    await this.monitor.stop();

    const shutdownPromises: Promise<void>[] = [this.drift.shutdown()];
    if (this.binance) {
      shutdownPromises.push(this.binance.shutdown());
    }
    if (this.driftVault) {
      shutdownPromises.push(this.driftVault.shutdown());
    }
    await Promise.all(shutdownPromises);

    logger.info("AI Strategy Agent stopped");
  }

  /**
   * Emergency shutdown — unwinds all positions before stopping.
   * Use this when you need to close everything (e.g., before mainnet migration).
   */
  async emergencyStop(): Promise<void> {
    logger.info("EMERGENCY STOP — unwinding all positions before shutdown");
    if (this.engine) {
      await this.engine.emergencyUnwind();
    }
    await this.stop();
  }

  getStatus(): object {
    if (!this.engine) return { status: "not initialized" };

    const state = this.engine.getState();
    return {
      status: this.running ? "running" : "stopped",
      mode: config.strategyMode,
      cycle: state.cycleCount,
      regime: state.regime,
      totalCapital: state.totalCapital.toFixed(2),
      deployedCapital: state.deployedCapital.toFixed(2),
      idleCapital: state.idleCapital.toFixed(2),
      totalPnl: state.totalPnl.toFixed(4),
      healthRatio: state.healthRatio.toFixed(4),
      fundingPnl: this.drift.getUnrealizedFundingPnl().toFixed(4),
      freeCollateral: this.drift.getFreeCollateral().toFixed(2),
      apyEstimate: `${state.apyEstimate.toFixed(2)}%`,
      yieldBreakdown: this.yieldAnalytics.formatBreakdown(
        this.yieldAnalytics.calculateBreakdown(state)
      ),
      directionFlips: state.directionFlips,
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
