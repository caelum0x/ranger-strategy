import {
  BN,
  DLOBNode,
  MakerInfo,
  MarketType,
  PRICE_PRECISION,
  convertToNumber,
  DriftClient,
  PriorityFeeMethod,
  PriorityFeeSubscriber,
  TxParams,
  User,
  UserMap,
  ZERO,
  getUserStatsAccountPublicKey,
  getTokenAmount,
  isVariant,
  isUserBankrupt,
} from "@drift-labs/sdk";
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { DriftExecutor } from "../drift/executor";
import { logger } from "../utils/logger";

interface CandidateUser {
  user: User;
  marginRequirement: BN;
  canBeLiquidated: boolean;
  closestLiquidationDistancePct: number;
  bankrupt: boolean;
  userKey: string;
}

const THROTTLE_BACKOFF_MS = 5_000;

export class LiquidationService {
  private readonly client: DriftClient;
  private readonly executor: DriftExecutor;
  private userMap?: UserMap;
  private priorityFeeSubscriber?: PriorityFeeSubscriber;
  private tickInProgress = false;
  private throttledUsers = new Map<string, number>();

  constructor(client: DriftClient, executor: DriftExecutor) {
    this.client = client;
    this.executor = executor;
  }

  async initialize(): Promise<void> {
    const userMapConnection = new Connection(config.solanaRpcUrl, "confirmed");
    this.userMap = new UserMap({
      driftClient: this.client,
      connection: userMapConnection,
      subscriptionConfig: {
        type: "polling",
        frequency: config.liquidationScanIntervalMs,
        commitment: "confirmed",
      },
      skipInitialLoad: false,
      includeIdle: false,
    } as any);

    await this.userMap.subscribe();
    this.priorityFeeSubscriber = new PriorityFeeSubscriber({
      connection: userMapConnection,
      frequencyMs: Math.max(2_000, config.liquidationScanIntervalMs),
      priorityFeeMethod: PriorityFeeMethod.HELIUS,
      heliusRpcUrl: config.heliusRpcUrl,
      addresses: [this.client.wallet.publicKey],
      priorityFeeMultiplier: config.liquidationPriorityFeeMultiplier,
      maxFeeMicroLamports: config.liquidationMaxPriorityFeeMicroLamports,
    });
    await this.priorityFeeSubscriber.subscribe();

    logger.info("Liquidation service initialized", {
      intervalMs: config.liquidationScanIntervalMs,
      maxUsersPerTick: config.liquidationMaxUsersPerTick,
      liquidationPriorityFeeMultiplier:
        config.liquidationPriorityFeeMultiplier,
    });
  }

  async shutdown(): Promise<void> {
    await this.priorityFeeSubscriber?.unsubscribe();
    await this.userMap?.unsubscribe();
  }

  async runOnce(): Promise<void> {
    if (!this.userMap) {
      throw new Error("LiquidationService is not initialized");
    }
    if (this.tickInProgress) {
      logger.warn("Skipping liquidation tick, previous tick still running");
      return;
    }

    this.tickInProgress = true;
    try {
      const candidates = this.collectCandidates();
      const summary = {
        checkedUsers: this.userMap.size(),
        liquidatableUsers: candidates.length,
        attempted: 0,
        perpLiquidations: 0,
        spotLiquidations: 0,
        perpPnlLiquidations: 0,
        bankruptcyResolutions: 0,
        throttled: 0,
      };

      for (const candidate of candidates.slice(0, config.liquidationMaxUsersPerTick)) {
        const result = await this.tryLiquidateUser(candidate);
        if (result === "throttled") summary.throttled++;
        if (result === "perp") summary.perpLiquidations++;
        if (result === "spot") summary.spotLiquidations++;
        if (result === "perp-pnl") summary.perpPnlLiquidations++;
        if (result === "bankruptcy") summary.bankruptcyResolutions++;
        if (result !== "none" && result !== "throttled") summary.attempted++;
      }

      logger.info("Liquidation scan complete", summary);
    } finally {
      this.tickInProgress = false;
    }
  }

  private collectCandidates(): CandidateUser[] {
    const candidates: CandidateUser[] = [];
    for (const user of this.userMap!.values()) {
      const { canBeLiquidated, marginRequirement } = user.canBeLiquidated();
      const bankrupt = isUserBankrupt(user) || user.isBankrupt();
      if (!canBeLiquidated && !user.isBeingLiquidated() && !bankrupt) {
        continue;
      }

      if (user.getUserAccount().authority.equals(this.client.wallet.publicKey)) {
        continue;
      }

      candidates.push({
        user,
        marginRequirement,
        canBeLiquidated,
        closestLiquidationDistancePct: this.getClosestLiquidationDistancePct(user),
        bankrupt,
        userKey: user.userAccountPublicKey.toBase58(),
      });
    }

    candidates.sort((a, b) => {
      if (a.bankrupt !== b.bankrupt) {
        return a.bankrupt ? -1 : 1;
      }

      if (a.closestLiquidationDistancePct !== b.closestLiquidationDistancePct) {
        return a.closestLiquidationDistancePct - b.closestLiquidationDistancePct;
      }

      if (a.marginRequirement.eq(b.marginRequirement)) {
        return 0;
      }

      return b.marginRequirement.gt(a.marginRequirement) ? 1 : -1;
    });
    return candidates;
  }

  private async tryLiquidateUser(
    candidate: CandidateUser
  ): Promise<"perp" | "spot" | "perp-pnl" | "bankruptcy" | "throttled" | "none"> {
    const { user, canBeLiquidated, userKey } = candidate;

    try {
      if (this.isThrottled(userKey)) {
        return "throttled";
      }

      if (candidate.bankrupt) {
        const resolved = await this.tryResolveBankruptUser(user);
        if (!resolved) {
          this.throttleUser(userKey);
        }
        return resolved ? "bankruptcy" : "none";
      }

      if (!canBeLiquidated && user.isBeingLiquidated()) {
        logger.info("User already being liquidated; attempting maintenance liquidation", {
          user: userKey,
        });
      }

      const perpPnlTransfer = this.selectPerpPnlTransfer(user);
      if (perpPnlTransfer) {
        const liquidatorSubAccountId = this.getSubAccountIdToLiquidatePerp(
          perpPnlTransfer.perpMarketIndex
        );
        if (liquidatorSubAccountId !== undefined) {
          const liquidatorUser = this.client.getUser(liquidatorSubAccountId);
          const maxPnlTransfer = liquidatorUser.getFreeCollateral("Initial");
          if (maxPnlTransfer.gt(ZERO)) {
            if (config.liquidationDryRun) {
              logger.info("Dry-run liquidatePerpPnlForDeposit", {
                user: userKey,
                perpMarketIndex: perpPnlTransfer.perpMarketIndex,
                assetMarketIndex: perpPnlTransfer.assetMarketIndex,
                maxPnlTransfer: maxPnlTransfer.toString(),
                liquidatorSubAccountId,
              });
              return "perp-pnl";
            }

            const txSig = await this.client.liquidatePerpPnlForDeposit(
              user.userAccountPublicKey,
              user.getUserAccount(),
              perpPnlTransfer.perpMarketIndex,
              perpPnlTransfer.assetMarketIndex,
              maxPnlTransfer,
              undefined,
              this.getLiquidationTxParams(),
              liquidatorSubAccountId
            );
            logger.info("Sent liquidatePerpPnlForDeposit tx", {
              user: userKey,
              perpMarketIndex: perpPnlTransfer.perpMarketIndex,
              assetMarketIndex: perpPnlTransfer.assetMarketIndex,
              liquidatorSubAccountId,
              txSig,
            });

            await this.deriskSubaccount(liquidatorSubAccountId);
            this.clearThrottle(userKey);
            return "perp-pnl";
          }
        }
      }

      const perpPosition = this.selectPerpPosition(user);
      if (perpPosition) {
        const liquidatorSubAccountId = this.getSubAccountIdToLiquidatePerp(
          perpPosition.marketIndex
        );
        if (liquidatorSubAccountId === undefined) {
          logger.info("No eligible subaccount configured for perp liquidation", {
            user: userKey,
            marketIndex: perpPosition.marketIndex,
          });
        } else {
        const makerInfos = await this.getMakerInfosForPerpLiquidation(
          user,
          perpPosition.marketIndex
        );
        const maxBaseAssetAmount = this.scaleTakeoverAmount(
          perpPosition.baseAssetAmount.abs()
        );
        if (config.liquidationDryRun) {
          logger.info("Dry-run liquidatePerp", {
            user: userKey,
            marketIndex: perpPosition.marketIndex,
            maxBaseAssetAmount: maxBaseAssetAmount.toString(),
            liquidatorSubAccountId,
            makerCount: makerInfos.length,
          });
          return "perp";
        }

        let txSig: string;
        if (makerInfos.length > 0) {
          txSig = await this.client.liquidatePerpWithFill(
            user.userAccountPublicKey,
            user.getUserAccount(),
            perpPosition.marketIndex,
            makerInfos,
            this.getLiquidationTxParams(),
            liquidatorSubAccountId
          );
        logger.info("Sent liquidatePerpWithFill tx", {
          user: userKey,
          marketIndex: perpPosition.marketIndex,
          liquidatorSubAccountId,
          makerCount: makerInfos.length,
          txSig,
        });
        } else {
          txSig = await this.client.liquidatePerp(
            user.userAccountPublicKey,
            user.getUserAccount(),
            perpPosition.marketIndex,
            maxBaseAssetAmount,
            undefined,
            this.getLiquidationTxParams(),
            liquidatorSubAccountId
          );
          logger.info("Sent liquidatePerp tx", {
            user: userKey,
            marketIndex: perpPosition.marketIndex,
            liquidatorSubAccountId,
            txSig,
          });
        }

        await this.deriskSubaccount(liquidatorSubAccountId);
        this.clearThrottle(userKey);
        return "perp";
        }
      }

      const spotPair = this.selectSpotPair(user);
      if (spotPair) {
        const liquidatorSubAccountId =
          this.getSubAccountIdToLiquidateSpot(spotPair.liabilityMarketIndex) ??
          this.getSubAccountIdToLiquidateSpot(spotPair.assetMarketIndex);
        if (liquidatorSubAccountId === undefined) {
          logger.info("No eligible subaccount configured for spot liquidation", {
            user: userKey,
            assetMarketIndex: spotPair.assetMarketIndex,
            liabilityMarketIndex: spotPair.liabilityMarketIndex,
          });
        } else {
        const maxLiabilityTransfer = this.scaleTakeoverAmount(
          spotPair.liabilityAmount
        );
        if (config.liquidationDryRun) {
          logger.info("Dry-run liquidateSpot", {
            user: userKey,
            assetMarketIndex: spotPair.assetMarketIndex,
            liabilityMarketIndex: spotPair.liabilityMarketIndex,
            maxLiabilityTransfer: maxLiabilityTransfer.toString(),
            liquidatorSubAccountId,
          });
          return "spot";
        }

        const txSig = await this.client.liquidateSpot(
          user.userAccountPublicKey,
          user.getUserAccount(),
          spotPair.assetMarketIndex,
          spotPair.liabilityMarketIndex,
          maxLiabilityTransfer,
          undefined,
          this.getLiquidationTxParams(),
          liquidatorSubAccountId
        );
        logger.info("Sent liquidateSpot tx", {
          user: userKey,
          assetMarketIndex: spotPair.assetMarketIndex,
          liabilityMarketIndex: spotPair.liabilityMarketIndex,
          liquidatorSubAccountId,
          txSig,
        });

        await this.deriskSubaccount(liquidatorSubAccountId);
        this.clearThrottle(userKey);
        return "spot";
        }
      }

      logger.info("No supported liquidation path found for user", { user: userKey });
      this.throttleUser(userKey);
      return "none";
    } catch (error) {
      this.throttleUser(userKey);
      logger.error("Liquidation attempt failed", {
        user: userKey,
        error,
      });
      return "none";
    }
  }

  private async tryResolveBankruptUser(user: User): Promise<boolean> {
    const userAccount = user.getUserAccount();
    const userAccountPublicKey = user.getUserAccountPublicKey();
    let resolved = false;

    for (const position of user.getActivePerpPositions()) {
      if (position.quoteAssetAmount.lt(ZERO)) {
        const liquidatorSubAccountId = this.getSubAccountIdToLiquidatePerp(
          position.marketIndex
        );
        if (config.liquidationDryRun) {
          logger.info("Dry-run resolvePerpBankruptcy", {
            user: userAccountPublicKey.toBase58(),
            marketIndex: position.marketIndex,
            liquidatorSubAccountId,
          });
          resolved = true;
          continue;
        }

        const txSig = await this.client.resolvePerpBankruptcy(
          userAccountPublicKey,
          userAccount,
          position.marketIndex,
          this.getLiquidationTxParams(),
          liquidatorSubAccountId
        );
        logger.info("Resolved perp bankruptcy", {
          user: userAccountPublicKey.toBase58(),
          marketIndex: position.marketIndex,
          liquidatorSubAccountId,
          txSig,
        });
        resolved = true;
      }
    }

    for (const position of user.getActiveSpotPositions()) {
      if (!isVariant(position.balanceType, "borrow")) {
        continue;
      }

      const liquidatorSubAccountId = this.getSubAccountIdToLiquidateSpot(
        position.marketIndex
      );
      if (config.liquidationDryRun) {
        logger.info("Dry-run resolveSpotBankruptcy", {
          user: userAccountPublicKey.toBase58(),
          marketIndex: position.marketIndex,
          liquidatorSubAccountId,
        });
        resolved = true;
        continue;
      }

      const txSig = await this.client.resolveSpotBankruptcy(
        userAccountPublicKey,
        userAccount,
        position.marketIndex,
        this.getLiquidationTxParams(),
        liquidatorSubAccountId
      );
      logger.info("Resolved spot bankruptcy", {
        user: userAccountPublicKey.toBase58(),
        marketIndex: position.marketIndex,
        liquidatorSubAccountId,
        txSig,
      });
      resolved = true;
    }

    return resolved;
  }

  private selectPerpPosition(user: User) {
    const positions = user
      .getActivePerpPositions()
      .filter((p) => !p.baseAssetAmount.isZero());

    positions.sort((a, b) =>
      a.baseAssetAmount.abs().lt(b.baseAssetAmount.abs()) ? 1 : -1
    );

    return positions[0];
  }

  private selectSpotPair(user: User):
    | {
        assetMarketIndex: number;
        liabilityMarketIndex: number;
        liabilityAmount: BN;
      }
    | undefined {
    const deposits = [];
    const borrows = [];

    for (const position of user.getActiveSpotPositions()) {
      const market = this.client.getSpotMarketAccount(position.marketIndex);
      if (!market) {
        continue;
      }

      const amount = getTokenAmount(
        position.scaledBalance,
        market,
        position.balanceType
      );

      if (amount.lte(ZERO)) {
        continue;
      }

      if (isVariant(position.balanceType, "deposit")) {
        deposits.push({
          marketIndex: position.marketIndex,
          amount,
        });
      } else if (isVariant(position.balanceType, "borrow")) {
        borrows.push({
          marketIndex: position.marketIndex,
          amount,
        });
      }
    }

    deposits.sort((a, b) => (a.amount.lt(b.amount) ? 1 : -1));
    borrows.sort((a, b) => (a.amount.lt(b.amount) ? 1 : -1));

    if (deposits.length === 0 || borrows.length === 0) {
      return undefined;
    }

    return {
      assetMarketIndex: deposits[0].marketIndex,
      liabilityMarketIndex: borrows[0].marketIndex,
      liabilityAmount: borrows[0].amount,
    };
  }

  private selectPerpPnlTransfer(user: User):
    | {
        perpMarketIndex: number;
        assetMarketIndex: number;
      }
    | undefined {
    const positivePnlPositions = user
      .getActivePerpPositions()
      .filter((position) => position.quoteAssetAmount.gt(ZERO))
      .sort((a, b) =>
        a.quoteAssetAmount.lt(b.quoteAssetAmount) ? 1 : -1
      );

    const deposits = user
      .getActiveSpotPositions()
      .filter((position) => isVariant(position.balanceType, "deposit"))
      .map((position) => {
        const market = this.client.getSpotMarketAccount(position.marketIndex);
        if (!market) {
          return undefined;
        }

        return {
          marketIndex: position.marketIndex,
          amount: getTokenAmount(
            position.scaledBalance,
            market,
            position.balanceType
          ),
        };
      })
      .filter((entry): entry is { marketIndex: number; amount: BN } => !!entry)
      .filter((entry) => entry.amount.gt(ZERO))
      .sort((a, b) => (a.amount.lt(b.amount) ? 1 : -1));

    if (positivePnlPositions.length === 0 || deposits.length === 0) {
      return undefined;
    }

    return {
      perpMarketIndex: positivePnlPositions[0].marketIndex,
      assetMarketIndex: deposits[0].marketIndex,
    };
  }

  private async getMakerInfosForPerpLiquidation(
    user: User,
    marketIndex: number
  ): Promise<MakerInfo[]> {
    if (!this.userMap) {
      return [];
    }

    try {
      const dlob = await this.userMap.getDLOB(this.userMap.getSlot());
      const oraclePriceData = this.client.getMMOracleDataForPerpMarket(
        marketIndex
      );
      const liquidateePosition = user.getPerpPosition(marketIndex);
      const wantsBids = !!liquidateePosition && liquidateePosition.baseAssetAmount.gt(ZERO);
      const generator = wantsBids
        ? dlob.getRestingLimitBids(
            marketIndex,
            this.userMap.getSlot(),
            MarketType.PERP,
            oraclePriceData
          )
        : dlob.getRestingLimitAsks(
            marketIndex,
            this.userMap.getSlot(),
            MarketType.PERP,
            oraclePriceData
          );

      const makerNodeMap = new Map<string, DLOBNode[]>();
      for (const node of generator) {
        if (!node.userAccount || node.isVammNode() || !node.order) {
          continue;
        }

        if (node.userAccount === user.userAccountPublicKey.toBase58()) {
          continue;
        }

        const bucket = makerNodeMap.get(node.userAccount) || [];
        bucket.push(node);
        makerNodeMap.set(node.userAccount, bucket);

        if (makerNodeMap.size >= 4) {
          break;
        }
      }

      const makerInfos: MakerInfo[] = [];
      for (const [makerUserAccountKey, makerNodes] of makerNodeMap) {
        const makerUser = await this.userMap.mustGet(makerUserAccountKey);
        const makerAuthority = makerUser.getUserAccount().authority;
        makerInfos.push({
          maker: makerUser.userAccountPublicKey,
          makerStats: getUserStatsAccountPublicKey(
            this.client.program.programId,
            makerAuthority
          ),
          makerUserAccount: makerUser.getUserAccount(),
          order: makerNodes[0]?.order,
        });
      }

      return makerInfos;
    } catch (error) {
      logger.warn("Failed to derive maker infos for perp liquidation", {
        marketIndex,
        user: user.userAccountPublicKey.toBase58(),
        error,
      });
      return [];
    }
  }

  private getClosestLiquidationDistancePct(user: User): number {
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const position of user.getActivePerpPositions()) {
      if (position.baseAssetAmount.isZero()) {
        continue;
      }

      const liqPrice = user.liquidationPrice(position.marketIndex);
      if (liqPrice.lte(ZERO)) {
        continue;
      }

      const oraclePrice = this.client.getOracleDataForPerpMarket(
        position.marketIndex
      ).price;
      closestDistance = Math.min(
        closestDistance,
        this.toRelativeDistancePct(oraclePrice, liqPrice)
      );
    }

    for (const position of user.getActiveSpotPositions()) {
      const market = this.client.getSpotMarketAccount(position.marketIndex);
      if (!market) {
        continue;
      }

      const amount = getTokenAmount(
        position.scaledBalance,
        market,
        position.balanceType
      );
      if (amount.lte(ZERO)) {
        continue;
      }

      const liqPrice = user.spotLiquidationPrice(position.marketIndex);
      if (liqPrice.lte(ZERO)) {
        continue;
      }

      const oraclePrice = this.client.getOracleDataForSpotMarket(
        position.marketIndex
      ).price;
      closestDistance = Math.min(
        closestDistance,
        this.toRelativeDistancePct(oraclePrice, liqPrice)
      );
    }

    return Number.isFinite(closestDistance) ? closestDistance : 999;
  }

  private toRelativeDistancePct(oraclePrice: BN, liqPrice: BN): number {
    const oracle = convertToNumber(oraclePrice, PRICE_PRECISION);
    const liq = convertToNumber(liqPrice, PRICE_PRECISION);
    if (!Number.isFinite(oracle) || oracle <= 0 || !Number.isFinite(liq)) {
      return 999;
    }

    return Math.abs((oracle - liq) / oracle) * 100;
  }

  private scaleTakeoverAmount(amount: BN): BN {
    const bps = new BN(Math.floor(config.liquidationTakeoverPct * 10_000));
    const scaled = amount.mul(bps).div(new BN(10_000));
    return scaled.gt(ZERO) ? scaled : amount;
  }

  private getSubAccountIdToLiquidatePerp(
    marketIndex: number
  ): number | undefined {
    const configured =
      config.liquidationPerpSubaccountMap[marketIndex] ??
      config.liquidationDefaultSubaccountId;

    if (!config.liquidationSubaccounts.includes(configured)) {
      return undefined;
    }

    return this.hasCollateralToLiquidate(configured) ? configured : undefined;
  }

  private getSubAccountIdToLiquidateSpot(
    marketIndex: number
  ): number | undefined {
    const configured =
      config.liquidationSpotSubaccountMap[marketIndex] ??
      config.liquidationDefaultSubaccountId;

    if (!config.liquidationSubaccounts.includes(configured)) {
      return undefined;
    }

    return this.hasCollateralToLiquidate(configured) ? configured : undefined;
  }

  private hasCollateralToLiquidate(subAccountId: number): boolean {
    try {
      const user = this.client.getUser(subAccountId);
      return user.getFreeCollateral("Initial").gt(ZERO);
    } catch {
      return false;
    }
  }

  private isThrottled(userKey: string): boolean {
    const lastAttempt = this.throttledUsers.get(userKey);
    if (!lastAttempt) {
      return false;
    }

    if (Date.now() - lastAttempt < THROTTLE_BACKOFF_MS) {
      logger.warn("Skipping throttled liquidation target", {
        user: userKey,
        retryInMs: THROTTLE_BACKOFF_MS - (Date.now() - lastAttempt),
      });
      return true;
    }

    this.throttledUsers.delete(userKey);
    return false;
  }

  private throttleUser(userKey: string): void {
    this.throttledUsers.set(userKey, Date.now());
  }

  private clearThrottle(userKey: string): void {
    this.throttledUsers.delete(userKey);
  }

  private getLiquidationTxParams(): TxParams {
    const priorityFee =
      this.priorityFeeSubscriber?.getCustomStrategyResult() ||
      config.liquidationFallbackPriorityFeeMicroLamports;

    return {
      computeUnits: config.liquidationComputeUnits,
      computeUnitsPrice: Math.max(
        priorityFee,
        config.liquidationFallbackPriorityFeeMicroLamports
      ),
    };
  }

  private async deriskSubaccount(subAccountId: number): Promise<void> {
    if (!config.liquidationAutoDerisk) {
      return;
    }

    try {
      await this.executor.deriskSubaccount(
        subAccountId,
        this.getLiquidationTxParams().computeUnitsPrice
      );
    } catch (error) {
      logger.warn("Failed to derisk liquidation subaccount", {
        subAccountId,
        error,
      });
    }
  }
}
