import {
  DriftClient,
  Wallet,
  loadKeypair,
  PositionDirection,
  OrderType,
  MarketType,
  convertToNumber,
  BASE_PRECISION,
  QUOTE_PRECISION,
  PRICE_PRECISION,
  FUNDING_RATE_PRECISION,
  BulkAccountLoader,
  DRIFT_PROGRAM_ID,
  BN,
} from "@drift-labs/sdk";
import { PublicKey } from "@solana/web3.js";
import type { Connection as SolConnection, Keypair as SolKeypair } from "@solana/web3.js";
import Decimal from "decimal.js";
import { config } from "../config";
import { FundingRate, Position } from "../strategy/types";
import { logger } from "../utils/logger";

// Drift market indices
// Spot: USDC=0, SOL=1, BTC=2, ETH=3
// Perp: SOL-PERP=0, BTC-PERP=1, ETH-PERP=2
const MARKET_INDEX: Record<string, { perp: number; spot: number }> = {
  SOL: { perp: 0, spot: 1 },
  BTC: { perp: 1, spot: 2 },
  ETH: { perp: 2, spot: 3 },
};

export interface DriftManagerConfig {
  /** Path to keypair JSON file, or raw Uint8Array */
  keypair: string | Uint8Array;
  /** Optional: operate as delegate for a vault's Drift user account */
  delegateFor?: {
    authority: PublicKey;
    subAccountIds: number[];
    activeSubAccountId: number;
  };
}

export class DriftManager {
  private client!: DriftClient;
  private connection: SolConnection;
  private wallet: Wallet;
  private delegateConfig?: DriftManagerConfig["delegateFor"];

  constructor(cfg: DriftManagerConfig) {
    const { Connection, Keypair } = require("@solana/web3.js");
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    this.delegateConfig = cfg.delegateFor;

    // Load wallet from keypair path or raw bytes
    if (typeof cfg.keypair === "string") {
      this.wallet = new Wallet(loadKeypair(cfg.keypair));
    } else {
      this.wallet = new Wallet(Keypair.fromSecretKey(cfg.keypair));
    }
  }

  async initialize(): Promise<void> {
    // Use polling subscription with BulkAccountLoader (recommended for bots)
    const accountLoader = new BulkAccountLoader(
      this.connection as any,
      "confirmed",
      1000 // poll interval ms
    );

    const clientConfig: any = {
      connection: this.connection as any,
      wallet: this.wallet,
      env: config.driftEnv,
      accountSubscription: {
        type: "polling",
        accountLoader,
      },
    };

    // Delegated account mode (for vault manager trading)
    // When signing on behalf of a delegated account, you MUST explicitly set
    // subAccountIds, activeSubAccountId, and authority
    if (this.delegateConfig) {
      clientConfig.authority = this.delegateConfig.authority;
      clientConfig.activeSubAccountId =
        this.delegateConfig.activeSubAccountId;
      clientConfig.subAccountIds = this.delegateConfig.subAccountIds;
      logger.info("Drift client configured for delegated account", {
        authority: this.delegateConfig.authority.toBase58(),
        subAccountIds: this.delegateConfig.subAccountIds,
      });
    }

    this.client = new DriftClient(clientConfig);
    await this.client.subscribe();

    // Check if user account exists
    const hasUser = await this.client.hasUser();
    if (!hasUser && !this.delegateConfig) {
      logger.warn(
        "No Drift user account found. Call initializeUser() before trading."
      );
    }

    logger.info("Drift client initialized and subscribed", {
      programId: DRIFT_PROGRAM_ID,
      env: config.driftEnv,
      publicKey: this.wallet.publicKey.toBase58(),
      delegated: !!this.delegateConfig,
    });
  }

  /**
   * Initialize a Drift user account and deposit initial USDC collateral.
   * Required before placing any orders.
   */
  async initializeUser(
    usdcAmount: Decimal,
    userUsdcTokenAccount: PublicKey
  ): Promise<void> {
    const hasUser = await this.client.hasUser();
    if (hasUser) {
      logger.info("Drift user account already exists");
      return;
    }

    logger.info(`Initializing Drift user with $${usdcAmount.toFixed(2)} USDC`);

    await this.client.initializeUserAccountAndDepositCollateral(
      new BN(usdcAmount.mul(1e6).toFixed(0)),
      userUsdcTokenAccount,
      0 // USDC spot market index
    );

    logger.info("Drift user account created and funded");
  }

  /**
   * Add a subaccount for isolating different strategy legs.
   * Each subaccount has its own positions and orders.
   */
  async addSubAccount(subAccountId: number): Promise<void> {
    const hasUser = this.client.hasUser(subAccountId);
    if (!hasUser) {
      await this.client.addUser(subAccountId);
      logger.info(`Subscribed to subaccount ${subAccountId}`);
    }
  }

  // ── Funding Rates ──────────────────────────────────────────────────

  async getFundingRates(): Promise<FundingRate[]> {
    const rates: FundingRate[] = [];

    for (const asset of config.targetAssets) {
      const indices = MARKET_INDEX[asset];
      if (!indices) continue;

      try {
        const perpMarket = this.client.getPerpMarketAccount(indices.perp);
        if (!perpMarket) continue;

        const lastRate = perpMarket.amm.lastFundingRate;
        const rateNum = convertToNumber(lastRate, FUNDING_RATE_PRECISION);

        // Hourly rate → annualized: rate * 24 * 365.25
        const annualized = rateNum * 24 * 365.25;

        rates.push({
          asset,
          venue: "drift",
          rate: new Decimal(rateNum),
          annualizedRate: new Decimal(annualized),
          timestamp: Date.now(),
          nextSettlement:
            perpMarket.amm.lastFundingRateTs.toNumber() * 1000 + 3600_000,
        });
      } catch (err) {
        logger.error(`Failed to fetch funding rate for ${asset} on Drift`, {
          error: err,
        });
      }
    }

    return rates;
  }

  /**
   * Fetch historical funding rates from the Drift Data API.
   */
  async getHistoricalFundingRates(
    asset: string,
    limit: number = 100
  ): Promise<FundingRate[]> {
    const symbol = `${asset}-PERP`;
    const url = `https://data.api.drift.trade/market/${symbol}/fundingRates?limit=${limit}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Data API error: ${resp.status}`);

    const data = (await resp.json()) as any[];

    return data.map((entry: any) => {
      const rate = entry.fundingRate / (entry.oraclePriceTwap || 1);
      return {
        asset,
        venue: "drift",
        rate: new Decimal(rate),
        annualizedRate: new Decimal(rate * 24 * 365.25),
        timestamp: entry.ts * 1000,
        nextSettlement: entry.ts * 1000 + 3600_000,
      };
    });
  }

  // ── Oracle ─────────────────────────────────────────────────────────

  async getOraclePrice(asset: string): Promise<Decimal> {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    const oracleData = this.client.getOracleDataForPerpMarket(indices.perp);
    return new Decimal(convertToNumber(oracleData.price, PRICE_PRECISION));
  }

  // ── Spot Trading ───────────────────────────────────────────────────

  async buySpot(asset: string, usdcAmount: Decimal): Promise<void> {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    const price = await this.getOraclePrice(asset);
    const baseAmount = usdcAmount.div(price);

    logger.info(`Buying ${baseAmount.toFixed(6)} ${asset} spot on Drift`, {
      usdcAmount: usdcAmount.toFixed(2),
      price: price.toFixed(2),
    });

    await this.client.placeSpotOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.SPOT,
      marketIndex: indices.spot,
      direction: PositionDirection.LONG,
      baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
    });
  }

  async sellSpot(asset: string, baseAmount: Decimal): Promise<void> {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    logger.info(`Selling ${baseAmount.toFixed(6)} ${asset} spot on Drift`);

    await this.client.placeSpotOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.SPOT,
      marketIndex: indices.spot,
      direction: PositionDirection.SHORT,
      baseAssetAmount: new BN(baseAmount.mul(1e9).toFixed(0)),
    });
  }

  // ── Perp Trading ───────────────────────────────────────────────────

  async shortPerp(asset: string, baseAmount: Decimal): Promise<void> {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    logger.info(`Shorting ${baseAmount.toFixed(6)} ${asset}-PERP on Drift`);

    await this.client.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: indices.perp,
      direction: PositionDirection.SHORT,
      baseAssetAmount: this.client.convertToPerpPrecision(
        parseFloat(baseAmount.toFixed(9))
      ),
    });
  }

  async longPerp(asset: string, baseAmount: Decimal): Promise<void> {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    logger.info(`Longing ${baseAmount.toFixed(6)} ${asset}-PERP on Drift`);

    await this.client.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: indices.perp,
      direction: PositionDirection.LONG,
      baseAssetAmount: this.client.convertToPerpPrecision(
        parseFloat(baseAmount.toFixed(9))
      ),
    });
  }

  async closePerp(asset: string): Promise<void> {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);

    const user = this.client.getUser();
    const perpPos = user.getPerpPosition(indices.perp);
    if (!perpPos || perpPos.baseAssetAmount.isZero()) {
      logger.info(`No ${asset}-PERP position to close`);
      return;
    }

    // If we're short (negative base), buy to close; if long, sell to close
    const direction = perpPos.baseAssetAmount.isNeg()
      ? PositionDirection.LONG
      : PositionDirection.SHORT;

    logger.info(`Closing ${asset}-PERP position on Drift`);

    await this.client.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: indices.perp,
      direction,
      baseAssetAmount: perpPos.baseAssetAmount.abs(),
      reduceOnly: true,
    });
  }

  /**
   * Place multiple orders atomically in a single transaction.
   */
  async placeOrdersAtomic(
    orders: Array<{
      asset: string;
      side: "long" | "short";
      type: "perp" | "spot";
      baseAmount: Decimal;
    }>
  ): Promise<void> {
    const orderParams = orders.map((o) => {
      const indices = MARKET_INDEX[o.asset];
      if (!indices) throw new Error(`Unknown asset: ${o.asset}`);

      const marketIndex =
        o.type === "perp" ? indices.perp : indices.spot;
      const marketType =
        o.type === "perp" ? MarketType.PERP : MarketType.SPOT;
      const direction =
        o.side === "long" ? PositionDirection.LONG : PositionDirection.SHORT;

      return {
        orderType: OrderType.MARKET,
        marketType,
        marketIndex,
        direction,
        baseAssetAmount:
          o.type === "perp"
            ? this.client.convertToPerpPrecision(
                parseFloat(o.baseAmount.toFixed(9))
              )
            : new BN(o.baseAmount.mul(1e9).toFixed(0)),
      };
    });

    logger.info(`Placing ${orderParams.length} orders atomically`);
    await this.client.placeOrders(orderParams as any);
  }

  // ── Funding Settlement ─────────────────────────────────────────────

  async settleFunding(): Promise<void> {
    logger.info("Settling funding payments on Drift");
    const userAccountPublicKey = await this.client.getUserAccountPublicKey();
    await this.client.settleFundingPayment(userAccountPublicKey);
  }

  // ── Deposits & Withdrawals ─────────────────────────────────────────

  async depositUSDC(
    amount: Decimal,
    tokenAccount: PublicKey
  ): Promise<void> {
    logger.info(`Depositing $${amount.toFixed(2)} USDC to Drift`);
    await this.client.deposit(
      new BN(amount.mul(1e6).toFixed(0)),
      0, // USDC = spot market index 0
      tokenAccount
    );
  }

  async withdrawUSDC(
    amount: Decimal,
    tokenAccount: PublicKey
  ): Promise<void> {
    logger.info(`Withdrawing $${amount.toFixed(2)} USDC from Drift`);
    await this.client.withdraw(
      new BN(amount.mul(1e6).toFixed(0)),
      0,
      tokenAccount
    );
  }

  async depositSOL(
    amount: Decimal,
    tokenAccount: PublicKey
  ): Promise<void> {
    logger.info(`Depositing ${amount.toFixed(4)} SOL to Drift`);
    await this.client.deposit(
      new BN(amount.mul(1e9).toFixed(0)),
      1, // SOL = spot market index 1
      tokenAccount
    );
  }

  // ── Position & Account Queries ─────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const user = this.client.getUser();
    const positions: Position[] = [];

    for (const asset of config.targetAssets) {
      const indices = MARKET_INDEX[asset];
      if (!indices) continue;

      // Perp position
      const perpPos = user.getPerpPosition(indices.perp);
      if (perpPos && !perpPos.baseAssetAmount.isZero()) {
        const baseAmount = convertToNumber(
          perpPos.baseAssetAmount,
          BASE_PRECISION
        );
        const price = await this.getOraclePrice(asset);
        const entryNotional = Math.abs(
          convertToNumber(perpPos.quoteEntryAmount, QUOTE_PRECISION)
        );
        const entryPrice =
          Math.abs(baseAmount) > 0 ? entryNotional / Math.abs(baseAmount) : 0;

        positions.push({
          asset,
          side: baseAmount > 0 ? "long" : "short",
          venue: "drift",
          size: new Decimal(Math.abs(baseAmount)),
          entryPrice: new Decimal(entryPrice),
          currentPrice: price,
          notionalValue: new Decimal(Math.abs(baseAmount)).mul(price),
          unrealizedPnl: new Decimal(
            convertToNumber(perpPos.quoteAssetAmount, QUOTE_PRECISION)
          ),
          leverage: this.getLeverage(),
          healthRatio: this.getHealthRatioSync(),
          timestamp: Date.now(),
        });
      }

      // Spot position (non-USDC)
      const tokenAmount = user.getTokenAmount(indices.spot);
      const amount = convertToNumber(tokenAmount, BASE_PRECISION);
      if (Math.abs(amount) > 0.0001) {
        const price = await this.getOraclePrice(asset);
        positions.push({
          asset,
          side: amount > 0 ? "long" : "short",
          venue: "drift",
          size: new Decimal(Math.abs(amount)),
          entryPrice: price, // spot doesn't track entry price
          currentPrice: price,
          notionalValue: new Decimal(Math.abs(amount)).mul(price),
          unrealizedPnl: new Decimal(0),
          leverage: new Decimal(1),
          healthRatio: new Decimal(999),
          timestamp: Date.now(),
        });
      }
    }

    return positions;
  }

  // ── Risk Metrics ───────────────────────────────────────────────────

  async getHealthRatio(): Promise<Decimal> {
    return this.getHealthRatioSync();
  }

  private getHealthRatioSync(): Decimal {
    const user = this.client.getUser();
    const collateral = convertToNumber(
      user.getTotalCollateral(),
      QUOTE_PRECISION
    );
    const marginReq = convertToNumber(
      user.getMarginRequirement("Initial"),
      QUOTE_PRECISION
    );
    if (marginReq === 0) return new Decimal(999);
    return new Decimal(collateral).div(marginReq);
  }

  private getLeverage(): Decimal {
    const user = this.client.getUser();
    const leverage = convertToNumber(user.getLeverage(), new BN(10000));
    return new Decimal(leverage);
  }

  getFreeCollateral(): Decimal {
    const user = this.client.getUser();
    return new Decimal(
      convertToNumber(user.getFreeCollateral(), QUOTE_PRECISION)
    );
  }

  getUnrealizedFundingPnl(): Decimal {
    const user = this.client.getUser();
    return new Decimal(
      convertToNumber(user.getUnrealizedFundingPNL(), QUOTE_PRECISION)
    );
  }

  getOpenOrders(): any[] {
    const user = this.client.getUser();
    return user.getOpenOrders();
  }

  // ── Market Data ────────────────────────────────────────────────────

  getPerpMarket(asset: string) {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);
    return this.client.getPerpMarketAccount(indices.perp);
  }

  getSpotMarket(asset: string) {
    const indices = MARKET_INDEX[asset];
    if (!indices) throw new Error(`Unknown asset: ${asset}`);
    return this.client.getSpotMarketAccount(indices.spot);
  }

  /**
   * Fetch market stats from Drift Data API (volumes, prices, funding).
   */
  async getMarketStats(): Promise<any> {
    const resp = await fetch("https://data.api.drift.trade/stats/markets");
    if (!resp.ok) throw new Error(`Data API error: ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch average funding rates across time periods from Data API.
   */
  async getAverageFundingRates(): Promise<any> {
    const resp = await fetch(
      "https://data.api.drift.trade/stats/fundingRates"
    );
    if (!resp.ok) throw new Error(`Data API error: ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch borrow rate history from Data API.
   */
  async getBorrowRateHistory(
    asset: string,
    limit: number = 100
  ): Promise<any> {
    const resp = await fetch(
      `https://data.api.drift.trade/stats/${asset}/rateHistory/borrow?limit=${limit}`
    );
    if (!resp.ok) throw new Error(`Data API error: ${resp.status}`);
    return resp.json();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  getClient(): DriftClient {
    return this.client;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  async shutdown(): Promise<void> {
    await this.client.unsubscribe();
    logger.info("Drift client shut down");
  }
}
