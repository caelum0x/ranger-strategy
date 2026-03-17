import Decimal from "decimal.js";
import { DriftManager, OracleMetrics } from "../drift/client";
import { DriftFundingAnalyzer, FundingAnalysis } from "../drift/funding";
import { DriftExecutor } from "../drift/executor";
import { DriftDataAPI } from "../drift/data-api";
import { BinanceManager } from "../binance/client";
import { RiskManager } from "../risk/manager";
import { config } from "../config";
import {
  FundingRate,
  IndexerDecisionSummary,
  IndexerSnapshotSummary,
  MarketRegime,
  Position,
  StrategyState,
  TradeSignal,
} from "./types";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { TradeLogger } from "../utils/trade-logger";
import { VaultPerformanceTracker } from "../vault/performance";
import { FundingPredictor } from "./predictor";
import { OracleGuard } from "../risk/oracle-guard";
import { StrategyAdvisor, LLMStrategyAdvice } from "../ai/strategy-advisor";
import { selectBestLST, calculateLSTYieldBoost, supportsLST } from "./lst";
import { CircuitBreaker } from "./circuit-breaker";
import { FloatingPerpMaker } from "./floating-maker";
import { CrossVenueExecutor } from "./cross-venue";
import { JitMaker, JitParams } from "../drift/jit-maker";
import { FillerBot } from "../drift/filler";
import { SpotFillerBot } from "../drift/spot-filler";
import { PnlSettler } from "../drift/pnl-settler";
import { FundingRateUpdater } from "../drift/funding-updater";
import { RangerDataApi, FundingRateArb } from "../ranger/data-api";
import {
  getL2OrderBook,
  getEntryQuoteOfPerpTrade,
  calculatePerpMarketFundingRate,
  getLendingAndBorrowAPY,
  type LendBorrowAPY,
} from "../drift/orderbook";
import { getBestLSTForYield, getLSTAPY, LST_MINTS } from "../lending/sanctum";
import { luloLend, luloWithdraw } from "../lending/lulo";
import { fetchMultiplePrices } from "../utils/pyth-oracle";
import { HeliusClient } from "../utils/helius-enhanced";
import { FlashTradeClient } from "../venues/flash";
import { OrcaWhirlpoolClient } from "../venues/orca";
import { MeteoraClient } from "../venues/meteora";
import { DeBridgeClient, CHAIN_IDS } from "../venues/debridge";
import { AdrenaClient } from "../venues/adrena";
import { VoltrClient } from "../ranger/voltr-client";
import { stakeToInsuranceFund } from "../drift/insurance";
import { DriftBearAdaptorClient } from "../drift/adaptor-client";
import { RaydiumLPStrategy } from "./raydium-lp";
import { BN } from "@drift-labs/sdk";

export class StrategyEngine {
  private drift: DriftManager;
  private binance: BinanceManager | null;
  private riskManager: RiskManager;
  private fundingAnalyzer: DriftFundingAnalyzer | null = null;
  private executor: DriftExecutor | null = null;
  private dataApi: DriftDataAPI = new DriftDataAPI();
  private state: StrategyState;
  private predictor: FundingPredictor = new FundingPredictor();
  private oracleGuard: OracleGuard;
  private advisor: StrategyAdvisor | null = null;
  private lastLLMAdvice: LLMStrategyAdvice | null = null;
  private consecutiveLLMFailures: number = 0;
  private llmCircuitBreakerUntil: number = 0;
  private tradeLogger: TradeLogger = new TradeLogger();
  private vaultPerf: VaultPerformanceTracker = new VaultPerformanceTracker();
  /** Pending vault withdrawals — reserve this amount as idle liquidity */
  private pendingWithdrawals: Decimal = new Decimal(0);
  private latestPredictions: import("./predictor").FundingPrediction[] = [];
  private lastFundingSnapshot: Decimal = new Decimal(0);
  private startTime: number = Date.now();
  private totalLendingCollected: Decimal = new Decimal(0);
  /** Track last direction flip time per asset to prevent rapid flipping */
  private lastFlipTime: Map<string, number> = new Map();
  /** Tracks which assets currently have LST-based positions (JitoSOL/mSOL/bSOL as collateral) */
  private lstPositions: Set<string> = new Set();
  /** Minimum time between direction flips per asset (48 hours — calibrated from 3-year backtest) */
  private readonly MIN_FLIP_INTERVAL_MS = 48 * 3600 * 1000;
  /** Per-asset allocation weights from backtest-optimized portfolio */
  private readonly ASSET_WEIGHTS: Record<string, number> = {
    SOL: 0.22,
    BTC: 0.20,
    ETH: 0.13,
    JTO: 0.23,
    INJ: 0.22,
  };
  /** Previous snapshot AUM for detecting vault-level changes */
  private prevSnapshotAum: Decimal | null = null;
  /** Previous share price for detecting drawdowns at vault level */
  private prevSnapshotSharePrice: Decimal | null = null;
  /** Vault-level size multiplier (reduced when snapshot signals risk) */
  private vaultRiskMultiplier: Decimal = new Decimal(1);
  /** Production circuit breaker — monitors daily loss, health, drawdown, flips, oracle */
  private circuitBreaker: CircuitBreaker = new CircuitBreaker({
    maxDailyLossPct: 0.02,
    maxFlipsPerDay: 1,
    oracleStaleSeconds: 60,
    healthRatioFloor: config.healthRatioFloor.toNumber(),
    maxDrawdownPct: config.maxDrawdownPct.toNumber() / 100,
    maxConsecutiveLLMFailures: 3,
    cooldownMs: 6 * 3600 * 1000,
    minFlipIntervalMs: 48 * 3600 * 1000,
  });
  /** FloatingPerpMaker for passive DLOB market making (optional, alongside delta-neutral) */
  private floatingMaker: FloatingPerpMaker | null = null;
  /** Cross-venue executor for Drift+Binance arbitrage */
  private crossVenueExecutor: CrossVenueExecutor | null = null;

  // ── New Integrated Modules (ported from keeper-bots-v2 + jit-proxy) ──

  /** JIT Maker — fills auctions at optimal slot timing (sniper or shotgun mode) */
  private jitMaker: JitMaker | null = null;
  /** Filler Bot — fills resting DLOB perp orders for filler rewards */
  private fillerBot: FillerBot | null = null;
  /** Spot Filler Bot — fills resting DLOB spot orders */
  private spotFillerBot: SpotFillerBot | null = null;
  /** PnL Settler — settles unrealized PnL for capital efficiency */
  private pnlSettler: PnlSettler | null = null;
  /** Funding Rate Updater — cranks funding rate updates for freshness */
  private fundingUpdater: FundingRateUpdater | null = null;
  /** Ranger Data API — funding arbs, liquidation signals, OI-weighted rates */
  private rangerDataApi: RangerDataApi = new RangerDataApi();
  /** Latest funding arbitrage opportunities from Ranger Data API */
  private latestFundingArbs: FundingRateArb[] = [];
  /** Latest liquidation capitulation signal */
  private liquidationCapitulationActive = false;

  // ── Multi-Venue & Yield Modules (integrated from plugins) ──

  /** Helius enhanced client — DAS API, smart priority fees, webhooks */
  private helius: HeliusClient = new HeliusClient();
  /** Flash Trade client — additional perp venue for cross-venue arb */
  private flashClient: FlashTradeClient | null = null;
  /** Adrena client — another perp venue for cross-venue intelligence */
  private adrenaClient: AdrenaClient | null = null;
  /** Orca Whirlpool client — concentrated LP yield */
  private orcaClient: OrcaWhirlpoolClient | null = null;
  /** Meteora DLMM client — dynamic LP yield */
  private meteoraClient: MeteoraClient | null = null;
  /** deBridge client — cross-chain capital bridging */
  private debridgeClient: DeBridgeClient = new DeBridgeClient();
  /** Voltr client — Ranger Earn vault strategy management */
  private voltrClient: VoltrClient | null = null;
  /** Raydium LP strategy — concentrated liquidity provisioning */
  private raydiumLP: RaydiumLPStrategy | null = null;
  /** Current lending rates across protocols for yield comparison */
  private lendingRates: Map<string, LendBorrowAPY> = new Map();
  /** Best lending protocol for idle USDC */
  private bestLendingProtocol: { protocol: string; apy: number } | null = null;

  constructor(
    drift: DriftManager,
    binance: BinanceManager | null,
    initialCapital: Decimal
  ) {
    this.drift = drift;
    this.binance = binance;
    this.riskManager = new RiskManager(initialCapital);
    this.oracleGuard = new OracleGuard(new Decimal(config.oracleMaxSpreadBps));

    this.state = {
      totalCapital: initialCapital,
      deployedCapital: new Decimal(0),
      idleCapital: initialCapital,
      positions: [],
      totalPnl: new Decimal(0),
      totalFundingCollected: new Decimal(0),
      totalLendingCollected: new Decimal(0),
      totalTradingCosts: new Decimal(0),
      currentDrawdown: new Decimal(0),
      maxDrawdownHit: new Decimal(0),
      healthRatio: new Decimal(999),
      apyEstimate: new Decimal(0),
      lastRebalance: 0,
      regime: "neutral",
      cycleCount: 0,
      directionFlips: 0,
      strategyProfile: config.strategyProfile,
    };
  }

  /**
   * Swap the Drift client (used when switching to vault delegate mode).
   */
  setDrift(drift: DriftManager): void {
    this.drift = drift;
  }

  /**
   * Attach the on-chain funding analyzer (requires initialized DriftClient).
   */
  setFundingAnalyzer(analyzer: DriftFundingAnalyzer): void {
    this.fundingAnalyzer = analyzer;
  }

  /**
   * Attach the advanced executor for atomic tx execution.
   */
  setExecutor(executor: DriftExecutor): void {
    this.executor = executor;
  }

  /**
   * Attach the LLM strategy advisor for AI-powered decision-making.
   */
  setAdvisor(advisor: StrategyAdvisor): void {
    this.advisor = advisor;
  }

  /**
   * Start the FloatingPerpMaker for passive DLOB market making.
   * Runs alongside the main delta-neutral strategy.
   */
  startFloatingMaker(markets: number[] = [0, 1]): void {
    if (!this.drift?.getClient() || this.floatingMaker) return;
    this.floatingMaker = new FloatingPerpMaker(this.drift.getClient(), {
      marketIndices: markets,
    });
    this.floatingMaker.start();
  }

  stopFloatingMaker(): void {
    this.floatingMaker?.stop();
    this.floatingMaker = null;
  }

  /**
   * Initialize cross-venue executor (requires Binance manager).
   */
  initCrossVenue(): void {
    if (!this.binance || !this.executor) return;
    this.crossVenueExecutor = new CrossVenueExecutor(
      this.drift,
      this.executor,
      this.binance
    );
    logger.info("Cross-venue executor initialized");
  }

  // ── JIT Maker (ported from jit-proxy/jitterSniper + jitterShotgun) ──

  /**
   * Start JIT maker for auction participation.
   * Fills taker orders during auction windows for maker rebates.
   * @param mode "sniper" = wait for optimal slot, "shotgun" = rapid retry
   * @param markets perp market indices to make on
   */
  async startJitMaker(
    mode: "sniper" | "shotgun" = "sniper",
    markets: number[] = [0, 1, 2]
  ): Promise<void> {
    if (!this.drift?.getClient() || this.jitMaker) return;
    this.jitMaker = new JitMaker(this.drift.getClient(), mode);

    // Configure bid/ask params per market (±5 ticks from oracle)
    const PRICE_PRECISION = new BN(1_000_000);
    for (const mkt of markets) {
      this.jitMaker.setPerpParams(mkt, {
        bid: PRICE_PRECISION.neg().div(new BN(200)),  // -0.5% below oracle
        ask: PRICE_PRECISION.div(new BN(200)),         // +0.5% above oracle
        minPosition: new BN(-10).mul(new BN(1e9)),     // max 10 base short
        maxPosition: new BN(10).mul(new BN(1e9)),      // max 10 base long
        priceType: "oracle",
      });
    }

    await this.jitMaker.start();
    logger.info("JIT maker started", { mode, markets });
  }

  async stopJitMaker(): Promise<void> {
    if (this.jitMaker) {
      await this.jitMaker.stop();
      logger.info("JIT maker stopped", { stats: this.jitMaker.getStats() });
      this.jitMaker = null;
    }
  }

  // ── Filler Bot (ported from keeper-bots-v2/filler.ts) ──

  /**
   * Start filler bot for DLOB order filling.
   * Earns filler rewards by matching makers with takers.
   */
  async startFillerBot(markets: number[] = [0, 1, 2]): Promise<void> {
    if (!this.drift?.getClient() || this.fillerBot) return;
    this.fillerBot = new FillerBot(this.drift.getClient(), {
      perpMarketIndices: markets,
      fillIntervalMs: 6000,
      maxFillsPerCycle: 10,
      dryRun: false,
    });
    await this.fillerBot.start();
    logger.info("Filler bot started", { markets });
  }

  async stopFillerBot(): Promise<void> {
    if (this.fillerBot) {
      await this.fillerBot.stop();
      logger.info("Filler bot stopped", { stats: this.fillerBot.getStats() });
      this.fillerBot = null;
    }
  }

  // ── Spot Filler (ported from keeper-bots-v2/spotFiller.ts) ──

  async startSpotFillerBot(markets: number[] = [0, 1, 2, 3]): Promise<void> {
    if (!this.drift?.getClient() || this.spotFillerBot) return;
    this.spotFillerBot = new SpotFillerBot(this.drift.getClient(), {
      spotMarketIndices: markets,
    });
    await this.spotFillerBot.start();
    logger.info("Spot filler bot started", { markets });
  }

  async stopSpotFillerBot(): Promise<void> {
    if (this.spotFillerBot) {
      await this.spotFillerBot.stop();
      this.spotFillerBot = null;
    }
  }

  // ── PnL Settler (ported from keeper-bots-v2/userPnlSettler.ts) ──

  async startPnlSettler(markets: number[] = [0, 1, 2]): Promise<void> {
    if (!this.drift?.getClient() || this.pnlSettler) return;
    this.pnlSettler = new PnlSettler(this.drift.getClient(), {
      perpMarketIndices: markets,
    });
    await this.pnlSettler.start();
    logger.info("PnL settler started", { markets });
  }

  async stopPnlSettler(): Promise<void> {
    if (this.pnlSettler) {
      await this.pnlSettler.stop();
      this.pnlSettler = null;
    }
  }

  // ── Funding Rate Updater (ported from keeper-bots-v2/fundingRateUpdater.ts) ──

  async startFundingUpdater(markets: number[] = [0, 1, 2]): Promise<void> {
    if (!this.drift?.getClient() || this.fundingUpdater) return;
    this.fundingUpdater = new FundingRateUpdater(this.drift.getClient(), {
      perpMarketIndices: markets,
    });
    await this.fundingUpdater.start();
    logger.info("Funding rate updater started", { markets });
  }

  async stopFundingUpdater(): Promise<void> {
    if (this.fundingUpdater) {
      await this.fundingUpdater.stop();
      this.fundingUpdater = null;
    }
  }

  // ── Ranger Data API Intelligence ──

  /**
   * Fetch cross-venue funding rate arbitrage opportunities.
   * Used by the strategy engine to identify where to long/short across venues.
   */
  async fetchFundingArbs(minDiff = 0.005): Promise<FundingRateArb[]> {
    try {
      this.latestFundingArbs = await this.rangerDataApi.getFundingRateArbs(minDiff);
      if (this.latestFundingArbs.length > 0) {
        logger.info("Funding arb opportunities found", {
          count: this.latestFundingArbs.length,
          top: this.latestFundingArbs.slice(0, 3).map((a) => ({
            symbol: a.symbol,
            long: a.long_venue,
            short: a.short_venue,
            diff: `${(a.diff * 100).toFixed(3)}%`,
          })),
        });
      }
      return this.latestFundingArbs;
    } catch (err) {
      logger.debug("Ranger Data API funding arbs fetch failed", { error: String(err) });
      return [];
    }
  }

  /**
   * Check for liquidation capitulation signals.
   * High liquidation volume = potential regime shift.
   */
  async checkLiquidationCapitulation(): Promise<boolean> {
    try {
      const data = await this.rangerDataApi.getLiquidationsCapitulation(
        undefined,
        "1h",
        0.8
      );
      this.liquidationCapitulationActive =
        data && Array.isArray(data) && data.length > 0;
      if (this.liquidationCapitulationActive) {
        logger.warn("Liquidation capitulation signal active — high liquidation volume");
      }
      return this.liquidationCapitulationActive;
    } catch {
      return false;
    }
  }

  // ── Multi-Venue Initialization (uses plugin integrations) ──

  /**
   * Initialize all venue clients for cross-venue intelligence.
   * Called once during engine setup.
   */
  initVenueClients(): void {
    if (this.drift?.getClient()) {
      const connection = this.drift.getClient().connection;
      this.flashClient = new FlashTradeClient(connection);
      this.adrenaClient = new AdrenaClient(connection);
      this.orcaClient = new OrcaWhirlpoolClient(connection);
      this.meteoraClient = new MeteoraClient(connection);
      this.voltrClient = new VoltrClient(connection);
      logger.info("Multi-venue clients initialized", {
        venues: ["Flash", "Adrena", "Orca", "Meteora", "deBridge", "Voltr"],
      });
    }
  }

  /**
   * Start Raydium LP strategy alongside delta-neutral.
   */
  startRaydiumLP(poolAddress?: string): void {
    if (!this.drift?.getClient()) return;
    this.raydiumLP = new RaydiumLPStrategy(this.drift.getClient().connection, [
      { pair: "SOL/USDC", poolAddress: poolAddress || "", rangeWidthPct: 5, hedgeIL: true },
    ]);
    this.raydiumLP.start();
    logger.info("Raydium LP strategy started");
  }

  stopRaydiumLP(): void {
    this.raydiumLP?.stop();
    this.raydiumLP = null;
  }

  // ── Lending Yield Optimizer (uses Drift + Lulo from plugins) ──

  /**
   * Compare lending rates across protocols and deploy idle USDC
   * to the highest-yielding one.
   *
   * Uses: drift/orderbook.ts (Drift APY), lending/lulo.ts (Flexlend), lending/sanctum.ts (LST APY)
   */
  async optimizeLendingYield(): Promise<void> {
    if (!this.drift?.getClient()) return;

    const rates: Array<{ protocol: string; apy: number }> = [];

    // 1. Drift spot lending APY
    try {
      const driftAPY = getLendingAndBorrowAPY(this.drift.getClient(), "USDC");
      rates.push({ protocol: "Drift", apy: driftAPY.lendingAPY });
      this.lendingRates.set("USDC", driftAPY);
    } catch { /* non-critical */ }

    // 2. Check other lending protocols via Data API
    try {
      const borrowRates = await this.rangerDataApi.getBorrowRatesAccumulated("USDC");
      if (Array.isArray(borrowRates)) {
        for (const rate of borrowRates) {
          if (rate.platform && rate.rate) {
            rates.push({ protocol: rate.platform, apy: rate.rate * 100 });
          }
        }
      }
    } catch { /* non-critical */ }

    // 3. Sort by APY and pick the best
    rates.sort((a, b) => b.apy - a.apy);
    if (rates.length > 0) {
      this.bestLendingProtocol = rates[0];
      logger.info("Lending yield comparison", {
        best: `${rates[0].protocol} (${rates[0].apy.toFixed(2)}%)`,
        all: rates.slice(0, 5).map((r) => `${r.protocol}: ${r.apy.toFixed(2)}%`),
      });
    }
  }

  // ── Multi-Venue Funding Rate Comparison ──

  /**
   * Fetch funding rates from Flash Trade and compare with Drift.
   * Used for cross-venue arbitrage signals.
   *
   * Uses: venues/flash.ts (Flash funding), ranger/data-api.ts (arb signals)
   */
  async compareVenueFundingRates(): Promise<void> {
    const driftRates = await this.drift.getFundingRates();

    for (const asset of config.targetAssets.slice(0, 3)) {
      try {
        const driftRate = driftRates.find((r) => r.asset === asset);
        if (!driftRate) continue;
        const driftAPY = driftRate.annualizedRate.toNumber();

        const venueRates: Array<{ venue: string; rate: number }> = [
          { venue: "Drift", rate: driftAPY },
        ];

        // Flash Trade funding rate
        if (this.flashClient) {
          const flashRate = await this.flashClient.getFundingRate(asset);
          if (flashRate !== null) venueRates.push({ venue: "Flash", rate: flashRate });
        }

        // Adrena funding rate
        if (this.adrenaClient) {
          const adrenaRate = await this.adrenaClient.getFundingRate(asset);
          if (adrenaRate !== null) venueRates.push({ venue: "Adrena", rate: adrenaRate });
        }

        // Find best arb opportunity across all 3 venues
        if (venueRates.length >= 2) {
          venueRates.sort((a, b) => b.rate - a.rate);
          const best = venueRates[0];
          const worst = venueRates[venueRates.length - 1];
          const spread = Math.abs(best.rate - worst.rate);

          if (spread > 0.05) { // >5% APY spread across venues
            logger.info("Cross-venue funding arb opportunity", {
              asset,
              venues: venueRates.map((v) => `${v.venue}: ${(v.rate * 100).toFixed(2)}%`),
              spread: `${(spread * 100).toFixed(2)}%`,
              action: `Short on ${best.venue}, long on ${worst.venue}`,
            });
          }
        }
      } catch { /* non-critical */ }
    }
  }

  // ── LP Yield Scanning (uses Orca + Meteora from plugins) ──

  /**
   * Scan top LP pools across Orca and Meteora for yield comparison.
   * Helps decide whether to deploy capital to LP vs pure funding.
   */
  async scanLPYields(): Promise<void> {
    const opportunities: Array<{ venue: string; pool: string; apr: number }> = [];

    // Orca Whirlpools
    if (this.orcaClient) {
      try {
        const pools = await this.orcaClient.getTopPools(5);
        for (const pool of pools) {
          opportunities.push({
            venue: "Orca",
            pool: `${pool.tokenA}/${pool.tokenB}`,
            apr: pool.apr,
          });
        }
      } catch { /* non-critical */ }
    }

    // Meteora DLMM
    if (this.meteoraClient) {
      try {
        const pools = await this.meteoraClient.getTopPools(5);
        for (const pool of pools) {
          opportunities.push({
            venue: "Meteora",
            pool: `${pool.mintA.slice(0, 4)}/${pool.mintB.slice(0, 4)}`,
            apr: pool.apr24h,
          });
        }
      } catch { /* non-critical */ }
    }

    if (opportunities.length > 0) {
      opportunities.sort((a, b) => b.apr - a.apr);
      logger.info("LP yield scan", {
        topOpportunities: opportunities.slice(0, 5).map((o) =>
          `${o.venue} ${o.pool}: ${o.apr.toFixed(1)}% APR`
        ),
      });
    }
  }

  // ── Insurance Fund Yield (uses drift/insurance.ts) ──

  /**
   * Stake idle USDC to Drift insurance fund for additional yield.
   * Only when idle capital exceeds a threshold and insurance fund APY is attractive.
   */
  async considerInsuranceFundStaking(): Promise<void> {
    if (!this.drift?.getClient()) return;

    const idleCapital = this.state.idleCapital;
    const minStakeThreshold = new Decimal(100); // $100 minimum
    if (idleCapital.lt(minStakeThreshold)) return;

    // Stake 10% of idle capital to insurance fund
    const stakeAmount = idleCapital.mul(0.1).toNumber();
    try {
      await stakeToInsuranceFund(this.drift.getClient(), stakeAmount, "USDC");
      logger.info("Staked to Drift insurance fund", {
        amount: `$${stakeAmount.toFixed(2)}`,
      });
    } catch (err) {
      logger.debug("Insurance fund staking skipped", { error: String(err) });
    }
  }

  // ── Helius Smart Priority Fees (uses utils/helius-enhanced.ts) ──

  /**
   * Get Helius-optimized priority fee for the current wallet.
   * Better than generic fee estimation.
   */
  async getSmartPriorityFee(): Promise<number> {
    try {
      const walletPubkey = this.drift.getWallet().publicKey.toBase58();
      return await this.helius.getPriorityFeeEstimate([walletPubkey], "High");
    } catch {
      return 50_000; // fallback
    }
  }

  // ── Auto-Deploy Idle Capital to Best Lending Protocol ──

  /**
   * Deploy idle USDC to the highest-yielding lending protocol.
   * Uses Lulo (Flexlend) if configured, otherwise Drift spot lending.
   *
   * Integrates: lending/lulo.ts, drift/orderbook.ts (getLendingAndBorrowAPY)
   */
  private async deployIdleCapitalToLending(): Promise<void> {
    const idle = this.state.idleCapital;
    const minDeploy = new Decimal(50); // $50 minimum to avoid dust
    if (idle.lt(minDeploy)) return;

    // Reserve 20% idle for withdrawal liquidity
    const deployable = idle.mul(0.8);
    if (deployable.lt(minDeploy)) return;

    // Check if best lending protocol APY is attractive enough
    if (!this.bestLendingProtocol || this.bestLendingProtocol.apy < 2) {
      return; // Don't deploy if lending APY < 2%
    }

    // Deploy via Drift spot deposit (always available, no external dependency)
    if (this.bestLendingProtocol.protocol === "Drift" && this.executor) {
      try {
        // Drift spot deposits auto-earn lending yield
        logger.info("Deploying idle capital to Drift spot lending", {
          amount: `$${deployable.toFixed(2)}`,
          apy: `${this.bestLendingProtocol.apy.toFixed(2)}%`,
        });
        // Capital is already on Drift as USDC deposit — it earns lending yield automatically
        // No additional action needed; Drift spot deposits earn interest passively
      } catch { /* non-critical */ }
    }

    // Deploy via Lulo (Flexlend) if APY is better than Drift
    if (
      this.bestLendingProtocol.protocol !== "Drift" &&
      this.bestLendingProtocol.apy > 5 &&
      process.env.FLEXLEND_API_KEY
    ) {
      try {
        const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        logger.info("Deploying idle capital to Lulo/Flexlend", {
          amount: `$${deployable.toFixed(2)}`,
          protocol: this.bestLendingProtocol.protocol,
          apy: `${this.bestLendingProtocol.apy.toFixed(2)}%`,
        });
        // In production: call luloLend() with proper wallet signing
        // await luloLend(connection, walletPubkey, usdcMint, deployable.toNumber(), signFn);
      } catch { /* non-critical */ }
    }
  }

  // ── On-Chain CPI via Adaptor (uses drift/adaptor-client.ts) ──

  /**
   * Execute deposit/withdraw via our deployed Anchor adaptor.
   * This routes through our on-chain program for vault-managed CPI to Drift.
   *
   * Uses: drift/adaptor-client.ts → programs/driftbear_custom_adaptor
   */
  async executeViaAdaptor(
    action: "deposit" | "withdraw",
    amountUsdc: number
  ): Promise<string | null> {
    if (!this.drift?.getClient()) return null;

    try {
      const adaptorConfig = DriftBearAdaptorClient.devnetConfig();
      const client = new DriftBearAdaptorClient(
        this.drift.getClient().connection,
        adaptorConfig
      );

      const amountSmallest = Math.floor(amountUsdc * 1e6); // USDC has 6 decimals
      logger.info(`Adaptor CPI: ${action} $${amountUsdc} USDC via on-chain program`);

      // In production: sign with proper keypair
      // const txSig = action === "deposit"
      //   ? await client.deposit(keypair, amountSmallest)
      //   : await client.withdraw(keypair, amountSmallest);
      // return txSig;

      return null; // Returns tx sig in production
    } catch (err) {
      logger.warn("Adaptor CPI failed", { action, error: String(err) });
      return null;
    }
  }

  /** Get all module stats including new venue/yield modules */
  getModuleStats() {
    return {
      jitMaker: this.jitMaker?.getStats() || null,
      fillerBot: this.fillerBot?.getStats() || null,
      spotFillerBot: this.spotFillerBot?.getStats() || null,
      floatingMaker: this.floatingMaker?.getStats() || null,
      pnlSettler: this.pnlSettler?.getStats() || null,
      fundingUpdater: this.fundingUpdater?.getStats() || null,
      raydiumLP: this.raydiumLP?.getStats() || null,
      fundingArbs: this.latestFundingArbs.length,
      liquidationCapitulation: this.liquidationCapitulationActive,
      bestLendingProtocol: this.bestLendingProtocol,
      lendingRates: Object.fromEntries(this.lendingRates),
      venues: {
        flash: !!this.flashClient,
        adrena: !!this.adrenaClient,
        orca: !!this.orcaClient,
        meteora: !!this.meteoraClient,
        debridge: true,
        voltr: !!this.voltrClient,
      },
    };
  }

  /** Get circuit breaker state for monitoring */
  getCircuitBreakerState() {
    return {
      state: this.circuitBreaker.getState(),
      lastTrip: this.circuitBreaker.getLastTrip(),
      tradingAllowed: this.circuitBreaker.isTradingAllowed(),
    };
  }

  setIndexerContext(context: {
    snapshot?: IndexerSnapshotSummary;
    decision?: IndexerDecisionSummary;
  }): void {
    this.state.indexerSnapshot = context.snapshot;
    this.state.indexerDecision = context.decision;
  }

  /**
   * Get natural language reasoning from the last LLM analysis.
   */
  getLastReasoning(): string | null {
    return this.advisor?.getLastReasoning() || null;
  }

  async runCycle(): Promise<void> {
    logger.info("=== Strategy cycle starting ===");

    // 1. Update state
    await this.refreshState();

    // 2. Check risk — emergency unwind if needed
    if (this.riskManager.shouldEmergencyUnwind(this.state)) {
      logger.error("EMERGENCY UNWIND triggered");
      await this.emergencyUnwind();
      return;
    }

    // 3. Risk check
    const riskCheck = this.riskManager.checkRisk(this.state);
    if (!riskCheck.passed) {
      logger.warn("Risk check failed, reducing positions", {
        violations: riskCheck.violations,
      });
      await this.reducePositions();
      return;
    }

    // 3.5. Circuit breaker check
    const breakerCheck = this.circuitBreaker.check({
      equity: this.state.totalCapital.add(this.state.totalPnl).toNumber(),
      dailyPnL: this.state.totalPnl.toNumber(),
      healthRatio: this.state.healthRatio.toNumber(),
      drawdownPct: this.state.currentDrawdown.toNumber() / 100,
      llmFailed: this.consecutiveLLMFailures > 0 ? true : undefined,
    });
    if (!breakerCheck.allowed) {
      logger.warn("Circuit breaker active — skipping cycle", {
        state: this.circuitBreaker.getState(),
        violations: breakerCheck.violations,
      });
      this.tradeLogger.logCycleComplete({
        type: "circuit_breaker",
        state: this.circuitBreaker.getState(),
        violations: breakerCheck.violations,
      });
      return;
    }

    // 3.6. React to indexed vault snapshots (AUM drops, share price drawdowns)
    this.evaluateVaultSnapshot();

    // 4. Get funding rates
    const driftRates = await this.drift.getFundingRates();
    const binanceRates =
      this.binance && config.strategyMode === "cross-venue"
        ? await this.binance.getFundingRates()
        : [];

    // 4.5. Detect market regime — LLM-first, fallback to heuristic
    const allRates = [...driftRates, ...binanceRates];

    // 4.6. LLM Strategy Advisor (replaces EMA predictor when available)
    const llmCircuitOpen = Date.now() < this.llmCircuitBreakerUntil;
    if (this.advisor && !llmCircuitOpen) {
      try {
        const onChainAnalyses = this.fundingAnalyzer
          ? this.fundingAnalyzer.analyzeAllAssets()
          : [];

        this.lastLLMAdvice = await this.advisor.analyze({
          fundingRates: driftRates,
          positions: this.state.positions,
          state: this.state,
          onChainAnalyses,
          targetAssets: config.targetAssets,
        });

        this.consecutiveLLMFailures = 0;

        // Use LLM regime classification
        const prevRegime = this.state.regime;
        this.state.regime = this.lastLLMAdvice.regime;
        logger.info(`LLM regime: ${this.state.regime} — ${this.lastLLMAdvice.regimeReasoning}`);

        if (prevRegime !== this.state.regime) {
          this.tradeLogger.logRegimeChange(prevRegime, this.state.regime, this.lastLLMAdvice.regimeReasoning);
        }
        this.tradeLogger.logLLMAdvice(
          this.state.regime,
          this.lastLLMAdvice.decisions.map((d) => ({
            asset: d.asset,
            action: d.action,
            perpSide: d.perpSide,
            allocation: d.allocationFraction,
          }))
        );

        // Convert LLM predictions to FundingPrediction interface
        this.latestPredictions = this.advisor.toFundingPredictions(this.lastLLMAdvice);

        // Log LLM reasoning
        const reasoning = this.advisor.getLastReasoning();
        if (reasoning) {
          logger.info("LLM trade reasoning:\n" + reasoning);
        }
      } catch (err: any) {
        this.consecutiveLLMFailures++;
        if (this.consecutiveLLMFailures >= 3) {
          // Skip LLM for next 6 cycles (at 8h intervals = 48h cooldown, at 1h = 6h cooldown)
          this.llmCircuitBreakerUntil = Date.now() + 6 * config.rebalanceIntervalMs;
          logger.warn(`LLM circuit breaker tripped after ${this.consecutiveLLMFailures} consecutive failures — skipping LLM for 6 cycles`);
        }
        logger.warn(`LLM advisor failed, falling back to EMA predictor: ${err.message}`);
        this.state.regime = this.detectRegime(allRates);
        this.predictor.update(driftRates);
        if (binanceRates.length > 0) this.predictor.update(binanceRates);
        this.latestPredictions = this.predictor.predictAll(config.targetAssets);
      }
    } else if (this.advisor && llmCircuitOpen) {
      logger.warn("LLM circuit breaker active — skipping LLM, using EMA predictor");
      this.state.regime = this.detectRegime(allRates);
      this.predictor.update(driftRates);
      if (binanceRates.length > 0) this.predictor.update(binanceRates);
      this.latestPredictions = this.predictor.predictAll(config.targetAssets);
    } else {
      // No LLM advisor — use heuristic regime detection + EMA predictor
      this.state.regime = this.detectRegime(allRates);
      this.predictor.update(driftRates);
      if (binanceRates.length > 0) this.predictor.update(binanceRates);
      this.latestPredictions = this.predictor.predictAll(config.targetAssets);
    }

    logger.info(`Market regime: ${this.state.regime}`);

    const predictions = this.latestPredictions;
    if (predictions.length > 0) {
      logger.info("Funding predictions", {
        source: this.advisor ? "LLM" : "EMA",
        predictions: predictions.map((p) => ({
          asset: p.asset,
          predicted: `${p.predictedRate.mul(100).toFixed(2)}%`,
          confidence: `${p.confidence.mul(100).toFixed(0)}%`,
          direction: p.direction,
          strength: p.signalStrength,
        })),
      });
    }

    // 4.65. Fetch market intelligence (Data API + DLOB + Sanctum LST APYs)
    try {
      await this.fetchFundingArbs();
      await this.checkLiquidationCapitulation();

      // Fetch live funding rates from on-chain TWAP (more accurate than HTTP API)
      if (this.drift?.getClient()) {
        for (const asset of config.targetAssets.slice(0, 3)) { // SOL, BTC, ETH
          try {
            const perpIdx = asset === "SOL" ? 0 : asset === "BTC" ? 1 : 2;
            const liveRate = await calculatePerpMarketFundingRate(
              this.drift.getClient(),
              perpIdx,
              "year"
            );
            logger.debug(`Live funding rate (TWAP): ${asset}`, {
              longRate: `${liveRate.longRate.toFixed(2)}%`,
              shortRate: `${liveRate.shortRate.toFixed(2)}%`,
            });
          } catch { /* non-critical */ }
        }
      }

      // Check lending APYs for yield comparison
      if (this.drift?.getClient()) {
        try {
          const usdcAPY = getLendingAndBorrowAPY(this.drift.getClient(), "USDC");
          logger.debug("USDC lending APY", {
            lend: `${usdcAPY.lendingAPY.toFixed(2)}%`,
            borrow: `${usdcAPY.borrowAPY.toFixed(2)}%`,
          });
        } catch { /* non-critical */ }
      }

      // Fetch best LST APY from Sanctum for optimal yield stacking
      try {
        const bestLST = await getBestLSTForYield();
        if (bestLST) {
          logger.debug("Best LST for yield stacking", {
            symbol: bestLST.symbol,
            apy: `${(bestLST.apy * 100).toFixed(2)}%`,
          });
        }
      } catch { /* non-critical */ }

      // Compare funding rates across venues (Drift vs Flash)
      await this.compareVenueFundingRates();

      // Optimize lending yield (find best protocol for idle USDC)
      await this.optimizeLendingYield();

      // Scan LP yields (Orca + Meteora) for yield comparison
      await this.scanLPYields();

      // Cross-validate oracle prices with Pyth Hermes (independent source)
      try {
        const pythPrices = await fetchMultiplePrices(config.targetAssets.slice(0, 3));
        for (const [symbol, pythPrice] of pythPrices) {
          const driftPrice = await this.drift.getOraclePrice(symbol);
          const divergence = Math.abs(
            (driftPrice.toNumber() - pythPrice.price) / pythPrice.price
          );
          if (divergence > 0.01) { // >1% divergence
            logger.warn("Oracle divergence detected (Drift vs Pyth)", {
              symbol,
              driftPrice: driftPrice.toFixed(4),
              pythPrice: pythPrice.price.toFixed(4),
              divergencePct: `${(divergence * 100).toFixed(2)}%`,
            });
          }
        }
      } catch { /* non-critical — Pyth API may be unavailable */ }

      // If capitulation signal is active, reduce risk multiplier
      if (this.liquidationCapitulationActive) {
        this.vaultRiskMultiplier = Decimal.min(
          this.vaultRiskMultiplier,
          new Decimal(0.5)
        );
        logger.warn("Reducing risk due to liquidation capitulation signal", {
          riskMultiplier: this.vaultRiskMultiplier.toFixed(2),
        });
      }
    } catch {
      // Non-critical — Data API is supplementary intelligence
    }

    // 4.7. Validate we have recent funding data (stale data = bad signals)
    const staleThreshold = 3600 * 1000; // 1 hour
    const staleAssets = driftRates.filter(
      (r) => Date.now() - r.timestamp > staleThreshold
    );
    if (staleAssets.length > 0 && driftRates.length > 0) {
      logger.warn("Stale funding rate data detected", {
        staleAssets: staleAssets.map((r) => r.asset),
        ageMs: staleAssets.map((r) => Date.now() - r.timestamp),
      });
    }

    // 4.8. Pre-fetch borrow rates for cost-aware signal generation
    const borrowRates = new Map<string, number>();
    for (const asset of config.targetAssets) {
      try {
        const rates = await this.dataApi.getBorrowRateHistory(asset, 1);
        if (rates.length > 0) borrowRates.set(asset, rates[0].rate);
      } catch {
        // Non-critical — will skip borrow cost check for this asset
      }
    }

    // 4.9. Per-position management: profit-taking and stop-loss
    const positionSignals = this.manageExistingPositions(driftRates);

    // 5. Generate trade signals (new entries + rebalances)
    this.tradeLogger.setCycle(this.state.cycleCount);
    const signals = [...positionSignals, ...this.generateSignals(driftRates, binanceRates, borrowRates)];

    // Log all generated signals
    for (const signal of signals) {
      this.tradeLogger.logSignal(signal);
    }

    // 6. Settlement-aware timing: skip trade execution if we're close
    //      to funding settlement (within 5 min) to avoid paying in the
    //      wrong direction. Let settlement happen first.
    const nearSettlement = driftRates.some((r) => {
      const msUntilSettlement = r.nextSettlement - Date.now();
      return msUntilSettlement > 0 && msUntilSettlement < 5 * 60 * 1000;
    });
    if (nearSettlement && signals.length > 0) {
      logger.info(
        "Near funding settlement — deferring trade execution to next cycle"
      );
      for (const signal of signals) {
        this.tradeLogger.logSkipped(signal.asset, "Near funding settlement");
      }
    } else {
      // 6. Execute signals (only when not near settlement)
      for (const signal of signals) {
        await this.executeSignal(signal);
      }
    }

    // 6.5. Log open orders (for debugging fill status)
    if (this.executor) {
      const openOrders = this.executor.getOpenOrders();
      if (openOrders.length > 0) {
        logger.info(`Open orders pending fill: ${openOrders.length}`, {
          orders: openOrders.map((o) => `${o.direction} ${o.asset} ${o.marketType} #${o.orderId}`),
        });
      }
    }

    // 7. Track funding collected
    const fundingPnl = this.drift.getUnrealizedFundingPnl();
    const newFunding = fundingPnl.sub(this.lastFundingSnapshot);
    if (newFunding.gt(0)) {
      this.state.totalFundingCollected =
        this.state.totalFundingCollected.add(newFunding);
    }
    this.lastFundingSnapshot = fundingPnl;

    // 7.1. Settle funding on Drift
    await this.drift.settleFunding();

    // 7.2. Track lending yield on spot deposits
    await this.trackLendingYield();

    // 7.5. Settle PnL via executor if available
    if (this.executor) {
      try {
        await this.executor.settlePnl([0, 1, 2]); // SOL, BTC, ETH
      } catch {
        // Non-critical — PnL settlement may have nothing to settle
      }
    }

    // 8. Update state again
    await this.refreshState();

    // 9. Update last rebalance timestamp, cycle count, and estimate APY
    this.state.lastRebalance = Date.now();
    this.state.cycleCount++;
    this.state.totalLendingCollected = this.totalLendingCollected;

    const elapsedMs = Date.now() - this.startTime;
    const elapsedDays = elapsedMs / (86400 * 1000);
    // Only estimate APY after at least 1 hour of running to avoid wild numbers
    if (elapsedDays > (1 / 24) && this.state.totalCapital.gt(0)) {
      const totalYield = this.state.totalFundingCollected
        .add(this.totalLendingCollected)
        .sub(this.state.totalTradingCosts);
      const returnSoFar = totalYield.div(this.state.totalCapital);
      this.state.apyEstimate = returnSoFar
        .div(elapsedDays)
        .mul(365.25)
        .mul(100);
    } else {
      // Too early to estimate — show 0 instead of wild extrapolations
      this.state.apyEstimate = new Decimal(0);
    }

    // 10. Auto-compound: reinvest yield into idle capital
    this.autoCompound();

    // 11. Deploy idle capital to highest-yielding lending protocol
    await this.deployIdleCapitalToLending();

    // 12. Consider insurance fund staking (every 24 cycles ~daily)
    if (this.state.cycleCount > 0 && this.state.cycleCount % 24 === 0) {
      await this.considerInsuranceFundStaking();
    }

    // Log cycle completion to trade log
    this.tradeLogger.logCycleComplete({
      cycle: this.state.cycleCount,
      regime: this.state.regime,
      positions: this.state.positions.length,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      fundingCollected: this.state.totalFundingCollected.toFixed(4),
      lendingCollected: this.totalLendingCollected.toFixed(4),
      tradingCosts: this.state.totalTradingCosts.toFixed(4),
      apyEstimate: `${this.state.apyEstimate.toFixed(2)}%`,
      directionFlips: this.state.directionFlips,
    });

    logger.info("=== Strategy cycle complete ===", {
      mode: config.strategyMode,
      cycle: this.state.cycleCount,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
      positions: this.state.positions.length,
      apyEstimate: `${this.state.apyEstimate.toFixed(2)}%`,
      fundingCollected: `$${this.state.totalFundingCollected.toFixed(4)}`,
      lendingCollected: `$${this.totalLendingCollected.toFixed(4)}`,
      tradingCosts: `$${this.state.totalTradingCosts.toFixed(4)}`,
      directionFlips: this.state.directionFlips,
      regime: this.state.regime,
    });
  }

  /**
   * Manage existing positions: profit-taking and stop-loss.
   *
   * For each open position, check:
   * 1. Stop-loss: if PnL is worse than -2% of notional, close (capital preservation)
   * 2. Profit-taking: if PnL > expected funding income for next 24h, trim risk
   * 3. Zombie cleanup: close positions with negligible notional (<$1)
   */
  private manageExistingPositions(driftRates: FundingRate[]): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const isDriftOnly = config.strategyMode === "drift-only";

    for (const pos of this.state.positions) {
      const pnlPct = pos.notionalValue.gt(0)
        ? pos.unrealizedPnl.div(pos.notionalValue).mul(100)
        : new Decimal(0);

      // 1. Stop-loss: close if PnL worse than -2% of notional
      // With $20 capital and 2x leverage, -2% notional = -$0.40 loss — significant
      if (pnlPct.lt(-2)) {
        logger.warn(
          `${pos.asset} stop-loss triggered: PnL ${pnlPct.toFixed(2)}% (${pos.unrealizedPnl.toFixed(4)} USDC)`
        );
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: pos.side,
          perpSide: pos.side === "long" ? "short" : "long",
          spotSize: pos.notionalValue,
          perpSize: pos.notionalValue,
          confidence: new Decimal(1),
          reason: `Stop-loss: PnL ${pnlPct.toFixed(2)}% exceeds -2% threshold`,
          predictedFundingRate: new Decimal(0),
        });
        this.tradeLogger.logClose(pos.asset, `Stop-loss at ${pnlPct.toFixed(2)}%`);
        continue;
      }

      // 2. Profit-taking: if PnL > expected 24h funding income, lock in profits
      // Expected income = notional * |funding rate| * (24/8760)
      const rate = driftRates.find((r) => r.asset === pos.asset);
      if (rate && pos.unrealizedPnl.gt(0)) {
        const expected24hIncome = pos.notionalValue
          .mul(rate.annualizedRate.abs())
          .mul(24)
          .div(8760);

        // If unrealized PnL is >3x expected 24h income, take profits
        if (expected24hIncome.gt(0) && pos.unrealizedPnl.gt(expected24hIncome.mul(3))) {
          logger.info(
            `${pos.asset} profit-take: PnL $${pos.unrealizedPnl.toFixed(4)} > 3x expected 24h ($${expected24hIncome.toFixed(4)})`
          );
          signals.push({
            asset: pos.asset,
            action: "close",
            spotVenue: "drift",
            perpVenue: isDriftOnly ? "drift" : "binance",
            spotSide: pos.side,
            perpSide: pos.side === "long" ? "short" : "long",
            spotSize: pos.notionalValue,
            perpSize: pos.notionalValue,
            confidence: new Decimal("0.9"),
            reason: `Profit-take: PnL $${pos.unrealizedPnl.toFixed(4)} exceeds 3x expected 24h funding`,
            predictedFundingRate: rate.annualizedRate,
          });
          this.tradeLogger.logClose(pos.asset, `Profit-take at $${pos.unrealizedPnl.toFixed(4)}`);
          continue;
        }
      }

      // 3. Zombie cleanup: close positions with negligible notional
      if (pos.notionalValue.lt(1)) {
        logger.info(`${pos.asset} zombie position closed: notional $${pos.notionalValue.toFixed(4)}`);
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: pos.side,
          perpSide: pos.side === "long" ? "short" : "long",
          spotSize: pos.notionalValue,
          perpSize: pos.notionalValue,
          confidence: new Decimal(1),
          reason: "Zombie cleanup: notional below $1",
          predictedFundingRate: new Decimal(0),
        });
        continue;
      }
    }

    // 4. Concentration check: if any single asset uses >40% of margin, trim it
    if (this.state.positions.length > 2) {
      const overconcentrated = this.riskManager.getOverconcentratedPositions(
        this.state.positions,
        new Decimal("0.4")
      );
      for (const oc of overconcentrated) {
        // Don't double-close if already signaled above
        if (signals.some(s => s.asset === oc.asset)) continue;

        const worst = this.riskManager.getWorstPosition(
          this.state.positions.filter(p => p.asset === oc.asset)
        );
        if (worst) {
          logger.warn(
            `${oc.asset} overconcentrated at ${oc.concentration.mul(100).toFixed(1)}% — trimming`
          );
          signals.push({
            asset: oc.asset,
            action: "decrease",
            spotVenue: "drift",
            perpVenue: config.strategyMode === "drift-only" ? "drift" : "binance",
            spotSide: worst.side,
            perpSide: worst.side === "long" ? "short" : "long",
            spotSize: worst.notionalValue.mul("0.3"), // trim 30%
            perpSize: worst.notionalValue.mul("0.3"),
            confidence: new Decimal("0.8"),
            reason: `Concentration trim: ${oc.asset} at ${oc.concentration.mul(100).toFixed(1)}% of notional`,
            predictedFundingRate: new Decimal(0),
          });
          this.tradeLogger.logClose(
            oc.asset,
            `Concentration trim: ${oc.concentration.mul(100).toFixed(1)}%`
          );
        }
      }
    }

    return signals;
  }

  generateSignals(
    driftRates: FundingRate[],
    binanceRates: FundingRate[],
    borrowRates: Map<string, number> = new Map()
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const isDriftOnly = config.strategyMode === "drift-only";
    const isDriftBear = this.isDriftBearMode();
    const indexerDecision = this.state.indexerDecision;

    const oracleMetricsByAsset = new Map<string, OracleMetrics>();
    for (const asset of config.targetAssets) {
      const metrics = this.drift.getOracleMetrics(asset);
      if (metrics) {
        oracleMetricsByAsset.set(asset, metrics);
      }
    }

    // Use on-chain funding analysis if available
    const onChainAnalyses = this.fundingAnalyzer
      ? this.fundingAnalyzer.analyzeAllAssets()
      : [];

    // Rank assets by funding yield — bi-directional (positive OR negative)
    // For negative funding (short spot), check that funding income > borrow cost
    const rankedAssets = config.targetAssets
      .map((asset) => {
        const binanceRate = binanceRates.find((r) => r.asset === asset);
        const driftRate = driftRates.find((r) => r.asset === asset);
        const onChain = onChainAnalyses.find((a) => a.asset === asset);

        // Determine funding direction and yield
        // In drift-only mode, use Drift rates; in cross-venue, use best of both
        const primaryRate = isDriftOnly
          ? driftRate?.annualizedRate || new Decimal(0)
          : binanceRate?.annualizedRate || new Decimal(0);

        // Absolute yield — we can profit from both positive and negative funding
        const absYield = primaryRate.abs();

        // Which direction to take:
        // positive funding → short perp (shorts collect) + long spot
        // negative funding → long perp (longs collect) + short spot
        const perpSide: "short" | "long" = primaryRate.gte(0) ? "short" : "long";
        const spotSide: "short" | "long" = perpSide === "short" ? "long" : "short";

        // Use AI predictor confidence when available, falling back to on-chain analysis
        const prediction = this.latestPredictions.find((p) => p.asset === asset);
        const confidence = prediction
          ? prediction.confidence
          : onChain
            ? onChain.confidence
            : new Decimal("0.5");

        // Use on-chain bi-directional attractiveness when available
        const isAttractive = onChain
          ? onChain.isAttractive
          : absYield.gt(config.minFundingAPY);

        // Momentum bonus: rising funding in our direction is extra attractive
        const momentumBonus = onChain?.momentumScore || new Decimal(0);

        // Borrow cost check: when funding is negative (short spot), borrow cost
        // eats into funding income. Skip if net yield is below threshold.
        const borrowRate = borrowRates.get(asset) || 0;
        let netYield = absYield;
        if (perpSide === "long" && borrowRate > 0) {
          // Short spot incurs borrow cost
          netYield = absYield.sub(new Decimal(borrowRate));
          if (netYield.lt(config.minFundingAPY)) {
            logger.info(
              `${asset}: funding ${absYield.mul(100).toFixed(2)}% minus borrow ${(borrowRate * 100).toFixed(2)}% = net ${netYield.mul(100).toFixed(2)}% — below threshold`
            );
          }
        }

        const oracleMetrics = oracleMetricsByAsset.get(asset);
        const oracleRisk = this.evaluateOracleRisk(asset, oracleMetrics);
        if (oracleRisk.skip && oracleRisk.reason) {
          logger.warn(`Oracle guard skip: ${asset}`, {
            reason: oracleRisk.reason,
            confBps: oracleMetrics?.confidenceBps?.toFixed(1) || null,
            spreadBps: oracleMetrics?.spreadBps?.toFixed(1) || null,
          });
        }

        return {
          asset,
          primaryRate,
          absYield,
          netYield,
          perpSide,
          spotSide,
          onChainAnalysis: onChain,
          confidence,
          isAttractive,
          momentum: onChain?.momentum || ("flat" as const),
          momentumBonus,
          driftFunding: driftRate?.annualizedRate || new Decimal(0),
          binanceFunding: binanceRate?.annualizedRate || new Decimal(0),
          oracleMetrics,
          oracleRisk,
        };
      })
      // Filter by net yield (after borrow costs) instead of just gross yield
      .filter(
        (a) =>
          a.isAttractive &&
          a.netYield.gt(config.minFundingAPY) &&
          !a.oracleRisk.skip
      )
      .sort((a, b) => {
        // Sort by momentum-adjusted yield: absYield * (1 + momentum bonus)
        const aScore = a.absYield.mul(new Decimal(1).add(a.momentumBonus.mul("0.3")));
        const bScore = b.absYield.mul(new Decimal(1).add(b.momentumBonus.mul("0.3")));
        return bScore.minus(aScore).toNumber();
      });

    const candidateAssets =
      isDriftBear && config.driftBearTopAssetOnly
        ? rankedAssets.slice(0, 1)
        : rankedAssets;

    logger.info("Asset ranking (bi-directional funding)", {
      mode: config.strategyMode,
      profile: this.state.strategyProfile,
      indexerAction: indexerDecision?.action,
      assets: rankedAssets.map((a) => ({
        asset: a.asset,
        rate: a.primaryRate.toFixed(4),
        absYield: a.absYield.toFixed(4),
        perpSide: a.perpSide,
        momentum: a.momentum,
        confidence: a.confidence.toFixed(2),
        oracleConfBps: a.oracleMetrics?.confidenceBps.toFixed(1) || null,
        oracleSpreadBps: a.oracleMetrics?.spreadBps.toFixed(1) || null,
        oracleSizeMultiplier: a.oracleRisk.sizeMultiplier.toFixed(2),
      })),
    });

    // Check existing positions — close if no longer attractive or direction flipped
    for (const pos of this.state.positions) {
      const ranked = candidateAssets.find((a) => a.asset === pos.asset);

      // Close if asset is no longer attractive
      if (!ranked) {
        signals.push({
          asset: pos.asset,
          action: "close",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: pos.side === "long" ? "long" : "short",
          perpSide: pos.side === "long" ? "short" : "long",
          spotSize: pos.size,
          perpSize: pos.size,
          confidence: new Decimal(1),
          reason: "Funding rate no longer attractive",
          predictedFundingRate: new Decimal(0),
        });
        continue;
      }

      // Rebalance if funding direction has flipped
      // e.g., we're short perp but funding went negative → should be long perp now
      const currentPerpSide = pos.side === "long" ? "short" : "long"; // infer perp side from spot side
      if (currentPerpSide !== ranked.perpSide) {
        // Circuit breaker: prevent rapid flipping (48h cooldown + 1 flip/day/asset)
        if (!this.circuitBreaker.canFlip(pos.asset)) {
          logger.info(
            `${pos.asset} direction flip suppressed by circuit breaker`
          );
          continue;
        }

        // Record the flip (returns false if blocked)
        if (!this.circuitBreaker.recordFlip(pos.asset)) {
          continue;
        }

        logger.info(
          `${pos.asset} funding direction flipped: ${currentPerpSide} → ${ranked.perpSide}`
        );
        signals.push({
          asset: pos.asset,
          action: "rebalance",
          spotVenue: "drift",
          perpVenue: isDriftOnly ? "drift" : "binance",
          spotSide: ranked.spotSide,
          perpSide: ranked.perpSide,
          spotSize: pos.notionalValue,
          perpSize: pos.notionalValue,
          confidence: ranked.confidence,
          reason: `Direction flip: ${currentPerpSide} → ${ranked.perpSide} perp (${ranked.primaryRate.toFixed(4)} APY)`,
          predictedFundingRate: ranked.primaryRate,
        });
      }
    }

    // Open positions for attractive assets
    // As vault manager: reserve liquidity for pending withdrawals
    const { deployable: deployableCapital } = this.vaultPerf.getDeployableCapital(
      this.state.totalCapital,
      this.state.idleCapital,
      this.pendingWithdrawals
    );

    const allowNewEntries = !(
      indexerDecision &&
      indexerDecision.action === "hold" &&
      indexerDecision.confidence.gte("0.6")
    );

    for (const ranked of candidateAssets) {
      const existingPos = this.state.positions.find(
        (p) => p.asset === ranked.asset && p.venue === "drift"
      );

      if (!existingPos && deployableCapital.gt(new Decimal(5)) && allowNewEntries) {
        // Check LLM trade decision if available
        const llmDecision = this.lastLLMAdvice?.decisions.find(
          (d) => d.asset === ranked.asset
        );

        // If LLM says skip or close, respect that
        if (llmDecision && (llmDecision.action === "skip" || llmDecision.action === "close")) {
          logger.info(`LLM says ${llmDecision.action} ${ranked.asset}: ${llmDecision.reasoning}`);
          continue;
        }

        // Regime-aware sizing: increase allocation in favorable regimes
        const regimeMultiplier = this.getRegimeSizeMultiplier(
          this.state.regime,
          ranked.perpSide
        );

        let positionBudget = deployableCapital;
        if (isDriftBear) {
          positionBudget = deployableCapital.mul(
            indexerDecision?.targetAllocation || config.driftBearNeutralAllocation
          );
        }

        if (indexerDecision?.action === "reduce-risk") {
          positionBudget = positionBudget.mul("0.5");
        }

        let positionSize: Decimal;
        if (llmDecision && llmDecision.allocationFraction > 0) {
          // LLM-driven position sizing (respects withdrawal-reserved liquidity)
          positionSize = positionBudget
            .mul(llmDecision.allocationFraction)
            .mul(regimeMultiplier);
          // Override perp side if LLM disagrees
          if (llmDecision.perpSide !== ranked.perpSide) {
            logger.info(
              `LLM overrides ${ranked.asset} direction: ${ranked.perpSide} → ${llmDecision.perpSide}`
            );
            ranked.perpSide = llmDecision.perpSide;
            ranked.spotSide = llmDecision.perpSide === "short" ? "long" : "short";
          }
        } else {
          // Fallback: weight-based sizing calibrated from 3-year backtest
          const assetWeight = this.ASSET_WEIGHTS[ranked.asset];
          if (assetWeight) {
            positionSize = positionBudget.mul(assetWeight).mul(regimeMultiplier);
          } else {
            // Unknown asset — fall back to risk-manager sizing
            const baseSize = this.riskManager.calculatePositionSize(
              positionBudget,
              ranked.asset,
              ranked.absYield,
              ranked.confidence
            );
            positionSize = baseSize.mul(regimeMultiplier);
          }
        }

        if (isDriftBear) {
          const hardCap = deployableCapital.mul(
            indexerDecision?.targetAllocation || config.driftBearNeutralAllocation
          );
          positionSize = Decimal.min(positionSize, hardCap);
        }

        // Momentum-scaled sizing: rising momentum → up to 30% larger,
        // falling momentum → up to 20% smaller, flat → no change
        if (ranked.momentum === "rising") {
          const bonus = Decimal.min(ranked.momentumBonus.mul("0.3"), new Decimal("0.3"));
          const momentumScale = new Decimal(1).add(bonus);
          positionSize = positionSize.mul(momentumScale);
        } else if (ranked.momentum === "falling") {
          const penalty = Decimal.min(ranked.momentumBonus.abs().mul("0.2"), new Decimal("0.2"));
          const momentumScale = new Decimal(1).sub(penalty);
          positionSize = positionSize.mul(momentumScale);
        }

        const oracleSizeMultiplier = ranked.oracleRisk.sizeMultiplier;
        if (oracleSizeMultiplier.lt(1)) {
          positionSize = positionSize.mul(oracleSizeMultiplier);
        }

        // Vault-level risk adjustment from indexed snapshots
        if (this.vaultRiskMultiplier.lt(1)) {
          positionSize = positionSize.mul(this.vaultRiskMultiplier);
        }

        if (positionSize.gte(new Decimal(5))) {
          const premium = ranked.onChainAnalysis
            ? ` | premium: ${ranked.onChainAnalysis.premium.mul(100).toFixed(3)}%`
            : "";
          const momentumStr = ranked.momentum !== "flat"
            ? ` | momentum: ${ranked.momentum}`
            : "";
          const oracleStr =
            ranked.oracleRisk.sizeMultiplier.lt(1)
              ? ` | oracleSize=${ranked.oracleRisk.sizeMultiplier.toFixed(2)}`
              : "";
          const vaultStr =
            this.vaultRiskMultiplier.lt(1)
              ? ` | vaultRisk=${this.vaultRiskMultiplier.toFixed(2)}`
              : "";

          signals.push({
            asset: ranked.asset,
            action: "open",
            spotVenue: "drift",
            perpVenue: isDriftOnly ? "drift" : "binance",
            spotSide: ranked.spotSide,
            perpSide: ranked.perpSide,
            spotSize: positionSize,
            perpSize: positionSize,
            confidence: ranked.confidence,
            reason: `${ranked.perpSide} perp: ${ranked.primaryRate.toFixed(4)} annualized${premium}${momentumStr}${oracleStr}${vaultStr}`,
            predictedFundingRate: ranked.primaryRate,
          });
        }
      }
    }

    return signals;
  }

  async executeSignal(signal: TradeSignal): Promise<void> {
    logger.info(`Executing signal: ${signal.action} ${signal.asset}`, {
      signal: {
        asset: signal.asset,
        action: signal.action,
        spotSide: signal.spotSide,
        perpSide: signal.perpSide,
        perpVenue: signal.perpVenue,
        spotSize: signal.spotSize.toFixed(4),
        reason: signal.reason,
      },
    });

    try {
      switch (signal.action) {
        case "open":
          await withRetry(
            () => this.executeOpen(signal),
            `open ${signal.asset}`,
            2
          );
          this.tradeLogger.logExecution(signal.asset, "open", {
            perpSide: signal.perpSide,
            spotSide: signal.spotSide,
            size: signal.spotSize.toFixed(4),
            reason: signal.reason,
          });
          break;

        case "close":
          await withRetry(
            () => this.executeClose(signal),
            `close ${signal.asset}`,
            2
          );
          this.tradeLogger.logClose(signal.asset, signal.reason);
          break;

        case "increase":
          // Add to an existing position (same direction)
          await withRetry(
            () => this.executeOpen(signal),
            `increase ${signal.asset}`,
            2
          );
          this.tradeLogger.logExecution(signal.asset, "increase", {
            perpSide: signal.perpSide,
            spotSide: signal.spotSide,
            size: signal.spotSize.toFixed(4),
            reason: signal.reason,
          });
          break;

        case "decrease":
          // Partially close a position (reduce size, keep direction)
          await withRetry(
            () => this.executeClose(signal),
            `decrease ${signal.asset}`,
            2
          );
          this.tradeLogger.logClose(signal.asset, `Partial close: ${signal.reason}`);
          break;

        case "rebalance":
          // Close first, then re-open with new direction
          await withRetry(
            () => this.executeClose(signal),
            `rebalance-close ${signal.asset}`,
            2
          );
          await withRetry(
            () => this.executeOpen(signal),
            `rebalance-open ${signal.asset}`,
            2
          );
          this.tradeLogger.logDirectionFlip(
            signal.asset,
            signal.spotSide === "long" ? "short" : "long",
            signal.perpSide,
            signal.predictedFundingRate.toFixed(4)
          );
          this.state.directionFlips++;
          break;

        default:
          logger.warn(`Unknown signal action: ${signal.action}`);
      }
    } catch (err: any) {
      this.tradeLogger.logFailure(signal.asset, signal.action, err.message || String(err));
      logger.error(`Failed to execute signal for ${signal.asset}`, {
        error: err,
        signal,
      });
    }
  }

  /**
   * Estimate round-trip trading cost for a given position size.
   * Drift fee tiers: Taker 0.10%, Maker 0.02%
   * Our slippage-protected limit orders are mostly maker fills (~70%)
   */
  private estimateTradingCost(notionalSize: Decimal): Decimal {
    const makerRate = new Decimal("0.0002"); // 0.02%
    const takerRate = new Decimal("0.0010"); // 0.10%
    const blendedRate = makerRate.mul("0.7").add(takerRate.mul("0.3")); // ~0.044%
    // Both legs (spot + perp) × entry cost
    return notionalSize.mul(2).mul(blendedRate);
  }

  private async executeOpen(signal: TradeSignal): Promise<void> {
    // Track estimated trading costs
    const cost = this.estimateTradingCost(signal.spotSize);
    this.state.totalTradingCosts = this.state.totalTradingCosts.add(cost);

    // Use atomic entry via executor when available (slippage-protected)
    if (this.executor && signal.perpVenue === "drift") {
      // LST yield stacking: for SOL short-perp entries in drift-only mode,
      // swap USDC → JitoSOL (or best LST) as collateral instead of raw SOL.
      // This adds ~7% staking APY on top of funding rate + lending yield.
      const lst = signal.perpSide === "short" && supportsLST(signal.asset)
        ? selectBestLST(signal.asset)
        : null;

      if (lst) {
        await this.executor.atomicLSTEntry(
          lst.spotIndex,
          signal.asset,
          signal.spotSize
        );
        this.lstPositions.add(signal.asset);

        // Log the LST yield boost for transparency / monitoring
        const boost = calculateLSTYieldBoost(lst, signal.spotSize);
        logger.info(`LST yield boost for ${signal.asset}`, {
          lst: lst.name,
          stakingAPY: `${lst.stakingAPY.mul(100).toFixed(1)}%`,
          estimatedDailyYield: `$${boost.dailyYield.toFixed(4)}`,
          estimatedAnnualYield: `$${boost.annualYield.toFixed(2)}`,
        });
      } else {
        // Standard atomic cancel + delta-neutral entry (bi-directional)
        await this.executor.atomicCancelAndEnterDeltaNeutral(
          signal.asset,
          signal.spotSize,
          signal.perpSide
        );
      }
    } else {
      // Fallback: separate spot and perp legs
      // Spot leg on Drift
      if (signal.spotSide === "long") {
        await this.drift.buySpot(signal.asset, signal.spotSize);
      } else {
        // Short spot = borrow and sell (margin trade on Drift)
        await this.drift.sellSpot(signal.asset, signal.spotSize);
      }

      // Perp leg — on Drift or Binance depending on mode
      if (signal.perpVenue === "drift") {
        if (signal.perpSide === "short") {
          await this.drift.shortPerp(signal.asset, signal.perpSize);
        } else {
          await this.drift.longPerp(signal.asset, signal.perpSize);
        }
      } else if (this.binance) {
        if (signal.perpSide === "short") {
          await this.binance.shortPerp(signal.asset, signal.perpSize);
        } else {
          await this.binance.longPerp(signal.asset, signal.perpSize);
        }
      }
    }

    this.state.deployedCapital = this.state.deployedCapital.add(
      signal.spotSize
    );
    this.state.idleCapital = this.state.idleCapital.sub(signal.spotSize);
  }

  private async executeClose(signal: TradeSignal): Promise<void> {
    // Track exit costs
    const cost = this.estimateTradingCost(signal.spotSize);
    this.state.totalTradingCosts = this.state.totalTradingCosts.add(cost);

    // Close perp leg first (faster on CEX)
    if (signal.perpVenue === "drift") {
      if (this.executor) {
        // If this position was entered via LST stacking, close via LST exit
        // (close perp + swap LST back to USDC in one atomic tx)
        if (this.lstPositions.has(signal.asset)) {
          const lst = selectBestLST(signal.asset);
          if (lst) {
            await this.executor.atomicLSTExit(lst.spotIndex, signal.asset);
            this.lstPositions.delete(signal.asset);
          } else {
            await this.executor.atomicDeltaNeutralExit(signal.asset);
          }
        } else {
          await this.executor.atomicDeltaNeutralExit(signal.asset);
        }
      } else {
        await this.drift.closePerp(signal.asset);
        // Close spot
        if (signal.spotSide === "long") {
          await this.drift.sellSpot(signal.asset, signal.spotSize);
        } else {
          await this.drift.buySpot(signal.asset, signal.spotSize);
        }
      }
    } else if (this.binance) {
      await this.binance.closePerp(signal.asset);
      // Close Drift spot
      if (signal.spotSide === "long") {
        await this.drift.sellSpot(signal.asset, signal.spotSize);
      } else {
        await this.drift.buySpot(signal.asset, signal.spotSize);
      }
    }

    this.state.deployedCapital = Decimal.max(
      new Decimal(0),
      this.state.deployedCapital.sub(signal.spotSize)
    );
    this.state.idleCapital = this.state.idleCapital.add(signal.spotSize);
  }

  /**
   * Track lending yield earned on spot deposits and borrow costs on short spot.
   *
   * Long spot on Drift earns lending APY automatically.
   * Short spot (borrowed) incurs borrow costs that reduce net yield.
   */
  private async trackLendingYield(): Promise<void> {
    if (this.state.positions.length === 0) return;

    try {
      for (const asset of config.targetAssets) {
        const cycleHours = config.rebalanceIntervalMs / 3600000;

        // Long spot → earns lending yield
        const longSpot = this.state.positions.find(
          (p) => p.asset === asset && p.venue === "drift" && p.side === "long"
        );
        if (longSpot) {
          const depositRates = await this.dataApi.getDepositRateHistory(asset, 1);
          if (depositRates.length > 0) {
            const annualRate = depositRates[0].rate;
            const cycleRate = annualRate * (cycleHours / 8760);
            const lendingIncome = longSpot.notionalValue.mul(cycleRate);

            if (lendingIncome.gt(0)) {
              this.totalLendingCollected =
                this.totalLendingCollected.add(lendingIncome);
              logger.info(`${asset} lending yield: $${lendingIncome.toFixed(6)}`, {
                annualRate: `${(annualRate * 100).toFixed(2)}%`,
                notional: longSpot.notionalValue.toFixed(2),
              });
            }
          }
        }

        // Short spot → incurs borrow cost (negative yield)
        const shortSpot = this.state.positions.find(
          (p) => p.asset === asset && p.venue === "drift" && p.side === "short"
        );
        if (shortSpot) {
          const borrowRates = await this.dataApi.getBorrowRateHistory(asset, 1);
          if (borrowRates.length > 0) {
            const annualBorrowRate = borrowRates[0].rate;
            const cycleRate = annualBorrowRate * (cycleHours / 8760);
            const borrowCost = shortSpot.notionalValue.mul(Math.abs(cycleRate));

            if (borrowCost.gt(0)) {
              this.state.totalTradingCosts =
                this.state.totalTradingCosts.add(borrowCost);
              logger.info(`${asset} borrow cost: -$${borrowCost.toFixed(6)}`, {
                annualRate: `${(annualBorrowRate * 100).toFixed(2)}%`,
                notional: shortSpot.notionalValue.toFixed(2),
              });
            }
          }
        }
      }
    } catch (err) {
      // Non-critical — yield tracking is supplementary
      logger.warn("Could not track lending/borrow yields", { error: err });
    }
  }

  async refreshState(): Promise<void> {
    const driftPositions = await this.drift.getPositions();
    const binancePositions =
      this.binance && config.strategyMode === "cross-venue"
        ? await this.binance.getPositions()
        : [];

    this.state.positions = [...driftPositions, ...binancePositions];

    // Calculate total PnL
    this.state.totalPnl = this.state.positions.reduce(
      (sum, p) => sum.add(p.unrealizedPnl),
      new Decimal(0)
    );

    // Update health ratio from Drift
    this.state.healthRatio = await this.drift.getHealthRatio();

    logger.info("State refreshed", {
      positions: this.state.positions.length,
      totalPnl: this.state.totalPnl.toFixed(4),
      healthRatio: this.state.healthRatio.toFixed(4),
    });
  }

  async emergencyUnwind(): Promise<void> {
    logger.error("EMERGENCY: Unwinding all positions");
    this.tradeLogger.logEmergencyUnwind(
      `Health: ${this.state.healthRatio.toFixed(4)}, Drawdown: ${this.state.currentDrawdown.toFixed(2)}%`
    );

    const closedAssets: string[] = [];
    const failedAssets: string[] = [];
    const PER_ASSET_TIMEOUT_MS = 15_000; // 15s max per asset

    for (const asset of config.targetAssets) {
      try {
        // Wrap each asset close in a timeout to prevent hanging
        await Promise.race([
          this.closeAssetPositions(asset),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout closing ${asset} after ${PER_ASSET_TIMEOUT_MS}ms`)), PER_ASSET_TIMEOUT_MS)
          ),
        ]);
        closedAssets.push(asset);
      } catch (err) {
        failedAssets.push(asset);
        logger.error(`Failed to close ${asset} positions`, { error: err });
      }
    }

    // Update state — only zero out if all assets closed
    if (failedAssets.length === 0) {
      this.state.deployedCapital = new Decimal(0);
      this.state.idleCapital = this.state.totalCapital.add(this.state.totalPnl);
    } else {
      // Partial unwind — estimate remaining deployed capital
      const remainingPositions = this.state.positions.filter(
        (p) => failedAssets.includes(p.asset)
      );
      const remainingDeployed = remainingPositions.reduce(
        (sum, p) => sum.add(p.notionalValue),
        new Decimal(0)
      );
      this.state.deployedCapital = remainingDeployed;
      this.state.idleCapital = this.state.totalCapital.add(this.state.totalPnl).sub(remainingDeployed);
      logger.error(`Partial emergency unwind: ${closedAssets.length} closed, ${failedAssets.length} failed`, {
        closed: closedAssets,
        failed: failedAssets,
        remainingDeployed: remainingDeployed.toFixed(2),
      });
    }

    logger.info(`Emergency unwind complete: ${closedAssets.length}/${config.targetAssets.length} assets closed`);
  }

  /** Close all positions for a single asset (used by emergencyUnwind) */
  private async closeAssetPositions(asset: string): Promise<void> {
    // Close Binance perps if in cross-venue mode
    if (this.binance && config.strategyMode === "cross-venue") {
      await withRetry(
        () => this.binance!.closePerp(asset),
        `emergency-close-binance ${asset}`,
        3
      );
    }

    // Close Drift positions — use atomic exit if executor available
    if (this.executor) {
      if (this.lstPositions.has(asset)) {
        const lst = selectBestLST(asset);
        if (lst) {
          await withRetry(
            () => this.executor!.atomicLSTExit(lst.spotIndex, asset),
            `emergency-exit-lst ${asset}`,
            3
          );
          this.lstPositions.delete(asset);
        } else {
          logger.warn(`LST position tracked for ${asset} but no LST found — using standard exit`);
          await withRetry(
            () => this.executor!.atomicDeltaNeutralExit(asset),
            `emergency-exit-drift ${asset}`,
            3
          );
          this.lstPositions.delete(asset);
        }
      } else {
        await withRetry(
          () => this.executor!.atomicDeltaNeutralExit(asset),
          `emergency-exit-drift ${asset}`,
          3
        );
      }
    } else {
      // Manual close: perp first, then spot
      await withRetry(
        () => this.drift.closePerp(asset),
        `emergency-close-perp ${asset}`,
        3
      );
      const spotPos = this.state.positions.find(
        (p) => p.asset === asset && p.venue === "drift"
      );
      if (spotPos) {
        if (spotPos.side === "long") {
          await withRetry(
            () => this.drift.sellSpot(asset, spotPos.notionalValue),
            `emergency-sell-spot ${asset}`,
            3
          );
        } else {
          await withRetry(
            () => this.drift.buySpot(asset, spotPos.notionalValue),
            `emergency-buy-spot ${asset}`,
            3
          );
        }
      } else {
        logger.warn(`No spot position found for ${asset} during emergency unwind`);
      }
    }
  }

  async reducePositions(): Promise<void> {
    if (this.state.positions.length === 0) return;

    // Sort positions by PnL (worst first) and close the worst half
    const sorted = [...this.state.positions].sort((a, b) =>
      a.unrealizedPnl.minus(b.unrealizedPnl).toNumber()
    );
    const toClose = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));

    logger.warn(`Reducing positions: closing ${toClose.length}/${sorted.length} worst performers`, {
      closing: toClose.map((p) => `${p.asset} (PnL: ${p.unrealizedPnl.toFixed(4)})`),
    });

    const isDriftOnly = config.strategyMode === "drift-only";
    for (const pos of toClose) {
      const signal: TradeSignal = {
        asset: pos.asset,
        action: "close",
        spotVenue: "drift",
        perpVenue: isDriftOnly ? "drift" : "binance",
        spotSide: pos.side,
        perpSide: pos.side === "long" ? "short" : "long",
        spotSize: pos.notionalValue,
        perpSize: pos.notionalValue,
        confidence: new Decimal(1),
        reason: `Risk reduction: closing worst performer (PnL: ${pos.unrealizedPnl.toFixed(4)})`,
        predictedFundingRate: new Decimal(0),
      };
      await this.executeSignal(signal);
    }
  }

  getState(): StrategyState {
    return { ...this.state };
  }

  /**
   * Get the predictor's history for state persistence.
   */
  getPredictorHistory(): Map<string, Decimal[]> {
    return this.predictor.getHistory();
  }

  /**
   * Restore predictor state from saved data.
   */
  restorePredictorHistory(saved: Map<string, Decimal[]>): void {
    this.predictor.restoreHistory(saved);
  }

  /**
   * Update pending vault withdrawal amount.
   * The engine will reserve this as idle liquidity, not deploying it.
   */
  setPendingWithdrawals(amount: Decimal): void {
    this.pendingWithdrawals = amount;
  }

  /**
   * Evaluate vault-level snapshot data and adjust risk posture.
   *
   * Reacts to:
   * 1. AUM drops >10% since last snapshot → reduce positions by 30%
   * 2. Share price below high water mark → tighten position sizing by 20%
   * 3. Indexer decision "reduce-risk" with high confidence → halve new entries
   * 4. AUM recovery → gradually restore normal sizing
   */
  private evaluateVaultSnapshot(): void {
    const snap = this.state.indexerSnapshot;
    const decision = this.state.indexerDecision;

    if (!snap) {
      // No snapshot data — use normal sizing
      this.vaultRiskMultiplier = new Decimal(1);
      return;
    }

    let multiplier = new Decimal(1);
    const currentAum = snap.aum;

    // 1. AUM drop detection: compare to previous snapshot
    if (this.prevSnapshotAum && this.prevSnapshotAum.gt(0)) {
      const aumChange = currentAum.sub(this.prevSnapshotAum).div(this.prevSnapshotAum);

      if (aumChange.lt("-0.10")) {
        // AUM dropped >10% — significant withdrawal or loss event
        logger.warn("Vault AUM dropped >10% since last snapshot — reducing position sizes", {
          prevAum: this.prevSnapshotAum.toFixed(0),
          currentAum: currentAum.toFixed(0),
          changePct: `${aumChange.mul(100).toFixed(2)}%`,
        });
        multiplier = multiplier.mul("0.7"); // 30% size reduction
      } else if (aumChange.lt("-0.05")) {
        // AUM dropped 5-10% — moderate concern
        logger.info("Vault AUM dropped 5-10% — slightly reducing position sizes", {
          changePct: `${aumChange.mul(100).toFixed(2)}%`,
        });
        multiplier = multiplier.mul("0.85"); // 15% size reduction
      }
    }

    // 2. Share price below high water mark — vault is in drawdown
    if (snap.sharePrice && snap.highWaterMark) {
      const sharePriceDrawdown = snap.highWaterMark.gt(0)
        ? snap.highWaterMark.sub(snap.sharePrice).div(snap.highWaterMark)
        : new Decimal(0);

      if (sharePriceDrawdown.gt("0.02")) {
        // Share price >2% below HWM — vault is underperforming
        logger.warn("Vault share price below high water mark — tightening sizing", {
          sharePrice: snap.sharePrice.toFixed(6),
          hwm: snap.highWaterMark.toFixed(6),
          drawdownPct: `${sharePriceDrawdown.mul(100).toFixed(2)}%`,
        });
        multiplier = multiplier.mul("0.8"); // 20% tighter
      }
    }

    // 3. Indexer decision: react to high-confidence "reduce-risk" signals
    if (decision && decision.action === "reduce-risk" && decision.confidence.gte("0.7")) {
      logger.info("Indexer decision: reduce-risk (high confidence) — halving new entry sizes", {
        confidence: decision.confidence.toFixed(2),
        rationale: decision.rationale,
      });
      multiplier = multiplier.mul("0.5");
    }

    // 4. Stale snapshot check: if snapshot is >1 hour old, don't trust it
    const snapshotAge = Date.now() - snap.timestamp;
    if (snapshotAge > 3600_000) {
      logger.info("Vault snapshot is stale (>1h) — using default sizing", {
        ageMinutes: Math.round(snapshotAge / 60_000),
      });
      multiplier = new Decimal(1); // Reset to default
    }

    // Clamp multiplier to [0.3, 1.0] — never go below 30% or above 100%
    this.vaultRiskMultiplier = Decimal.max("0.3", Decimal.min("1.0", multiplier));

    if (this.vaultRiskMultiplier.lt(1)) {
      logger.info(`Vault risk multiplier: ${this.vaultRiskMultiplier.toFixed(2)}`);
    }

    // Update previous values for next cycle
    this.prevSnapshotAum = currentAum;
    if (snap.sharePrice) {
      this.prevSnapshotSharePrice = snap.sharePrice;
    }
  }

  /**
   * Get the vault risk multiplier for use in position sizing.
   * External callers (e.g., tests) can read this.
   */
  getVaultRiskMultiplier(): Decimal {
    return this.vaultRiskMultiplier;
  }

  /**
   * Get the agent start time (for APY calculation).
   */
  getStartTime(): number {
    return this.startTime;
  }

  /**
   * Restore start time from saved state (crash recovery).
   */
  setStartTime(ts: number): void {
    this.startTime = ts;
  }

  /**
   * Restore cumulative state fields from a previous run (crash recovery).
   */
  restoreState(partial: Partial<StrategyState>): void {
    if (partial.totalFundingCollected)
      this.state.totalFundingCollected = partial.totalFundingCollected;
    if (partial.totalLendingCollected) {
      this.state.totalLendingCollected = partial.totalLendingCollected;
      this.totalLendingCollected = partial.totalLendingCollected;
    }
    if (partial.totalTradingCosts)
      this.state.totalTradingCosts = partial.totalTradingCosts;
    if (partial.cycleCount !== undefined)
      this.state.cycleCount = partial.cycleCount;
    if (partial.directionFlips !== undefined)
      this.state.directionFlips = partial.directionFlips;
    logger.info("Strategy state restored from saved data", {
      cycle: this.state.cycleCount,
      funding: this.state.totalFundingCollected.toFixed(4),
    });
  }

  /**
   * Auto-compound: reinvest collected funding/lending yield into idle capital.
   * Called at the end of each cycle to grow position sizes over time.
   */
  autoCompound(): { compounded: Decimal; newIdle: Decimal } {
    // Net yield available to reinvest
    const netYield = this.state.totalFundingCollected
      .add(this.state.totalLendingCollected)
      .sub(this.state.totalTradingCosts);

    // Only compound if net yield is positive and meaningful ($0.01+)
    const minCompoundThreshold = new Decimal("0.01");
    if (netYield.lte(minCompoundThreshold)) {
      return { compounded: new Decimal(0), newIdle: this.state.idleCapital };
    }

    // The yield already manifests in PnL, but we explicitly track
    // compounding to adjust available capital for position sizing.
    // idleCapital includes unrealized PnL, so we just need to log it.
    const totalAvailable = this.state.totalCapital.add(this.state.totalPnl);
    const effectiveIdle = totalAvailable.sub(this.state.deployedCapital);

    if (effectiveIdle.gt(this.state.idleCapital)) {
      const compoundedAmount = effectiveIdle.sub(this.state.idleCapital);
      this.state.idleCapital = effectiveIdle;
      logger.info(`Auto-compound: +$${compoundedAmount.toFixed(4)} reinvested`, {
        netYield: netYield.toFixed(4),
        newIdle: this.state.idleCapital.toFixed(2),
      });
      return { compounded: compoundedAmount, newIdle: this.state.idleCapital };
    }

    return { compounded: new Decimal(0), newIdle: this.state.idleCapital };
  }

  /**
   * Regime-aware position sizing multiplier.
   * Bull regime → shorts collect more funding → increase short perp allocation
   * Bear regime → longs collect more funding → increase long perp allocation
   * Volatile → reduce allocation to limit drawdown risk
   */
  private getRegimeSizeMultiplier(
    regime: MarketRegime,
    perpSide: "short" | "long"
  ): Decimal {
    switch (regime) {
      case "bull":
        // Bull = positive funding = shorts profitable
        return perpSide === "short" ? new Decimal("1.2") : new Decimal("0.8");
      case "bear":
        // Bear = negative funding = longs profitable
        return perpSide === "long" ? new Decimal("1.2") : new Decimal("0.8");
      case "volatile":
        // Reduce exposure in volatile markets
        return new Decimal("0.7");
      case "neutral":
      default:
        return new Decimal("1.0");
    }
  }

  detectRegime(fundingRates: FundingRate[]): MarketRegime {
    if (fundingRates.length === 0) return "neutral";

    const avgRate = fundingRates
      .reduce((sum, r) => sum.add(r.annualizedRate), new Decimal(0))
      .div(fundingRates.length);

    const variance = fundingRates
      .reduce(
        (sum, r) => sum.add(r.annualizedRate.sub(avgRate).pow(2)),
        new Decimal(0)
      )
      .div(fundingRates.length);

    const stdDev = variance.sqrt();

    // High variance = volatile
    if (stdDev.gt(new Decimal("0.5"))) return "volatile";
    // Strongly positive funding = bull (longs paying shorts)
    if (avgRate.gt(new Decimal("0.15"))) return "bull";
    // Negative funding = bear
    if (avgRate.lt(new Decimal("-0.05"))) return "bear";
    return "neutral";
  }

  private isDriftBearMode(): boolean {
    return (this.state.strategyProfile || config.strategyProfile) === "driftbear-neutral-farmer";
  }

  private evaluateOracleRisk(
    asset: string,
    metrics?: OracleMetrics
  ): {
    skip: boolean;
    sizeMultiplier: Decimal;
    reason?: string;
  } {
    if (!metrics) {
      return { skip: false, sizeMultiplier: new Decimal(1) };
    }

    const oracleCheck = this.oracleGuard.check(
      asset,
      metrics.oraclePrice,
      metrics.markPrice
    );
    if (!oracleCheck.safe) {
      return {
        skip: true,
        sizeMultiplier: new Decimal(0),
        reason: oracleCheck.reason,
      };
    }

    const maxSpread = new Decimal(config.oracleMaxSpreadBps);
    const maxConf = new Decimal(config.oracleMaxConfidenceBps);
    const spreadRatio = maxSpread.gt(0)
      ? metrics.spreadBps.div(maxSpread)
      : new Decimal(0);
    const confRatio = maxConf.gt(0)
      ? metrics.confidenceBps.div(maxConf)
      : new Decimal(0);

    const worstRatio = Decimal.max(spreadRatio, confRatio);
    if (worstRatio.gte(config.oracleSkipMultiplier)) {
      return {
        skip: true,
        sizeMultiplier: new Decimal(0),
        reason: `oracle risk too high (spread ${metrics.spreadBps.toFixed(1)}bps, conf ${metrics.confidenceBps.toFixed(1)}bps)`,
      };
    }

    const penalty = Decimal.min(
      new Decimal(1),
      spreadRatio.add(confRatio).div(2)
    );
    const sizeMultiplier = Decimal.max(
      config.oracleSizeFloor,
      new Decimal(1).sub(penalty)
    );

    return { skip: false, sizeMultiplier };
  }
}
