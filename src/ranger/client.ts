import { VoltrClient, VaultConfigField } from "@voltr/vault-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DriftClient, Wallet } from "@drift-labs/sdk";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
  sendAndConfirmOptimisedTx,
  setupTokenAccount,
  getAddressLookupTableAccounts,
} from "../utils/solana-helpers";

// ── Drift constants ───────────────────────────────────────────────────────────
const DRIFT_PROGRAM_ID   = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
// Hardcoded STATE — not dynamically derived (matches voltrxyz/drift-scripts)
const DRIFT_STATE        = "5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN";
const DRIFT_LUT          = "Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL";
const USDC_MINT          = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MARKET_INDEX  = 0;
const SUB_ACCOUNT_ID     = 0;
const ENABLE_MARGIN      = false;

// Discriminators (from voltrxyz/drift-scripts/src/constants/drift.ts)
const DISCRIMINATOR_INITIALIZE_USER = Buffer.from([200, 103, 130, 67, 230, 84, 7, 225]);
const DISCRIMINATOR_DEPOSIT_USER    = Buffer.from([162, 73, 130, 153, 234, 34, 17, 56]);
const DISCRIMINATOR_WITHDRAW_USER   = Buffer.from([86, 169, 152, 107, 33, 180, 134, 115]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive Drift user / userStats PDAs directly (no SDK helpers). */
function driftPDAs(
  vaultStrategyAuth: PublicKey,
  driftProgram: PublicKey,
  subAccountId: number
): { userStats: PublicKey; user: PublicKey } {
  const subAccountIdBN = new BN(subAccountId);

  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    driftProgram
  );
  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      subAccountIdBN.toArrayLike(Buffer, "le", 2),
    ],
    driftProgram
  );
  return { userStats, user };
}

/** Derive the spot_market_vault PDA for a given market index. */
function driftCounterPartyTa(
  driftProgram: PublicKey,
  marketIndex: number
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    driftProgram
  );
  return pda;
}

/** Legacy sendAndConfirmTransaction wrapper for simple (non-Drift) ixs. */
async function sendIx(
  connection: Connection,
  ix: TransactionInstruction,
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

// ── RangerVaultManager ────────────────────────────────────────────────────────

export class RangerVaultManager {
  private client!: VoltrClient;
  private connection: Connection;
  private adminKp: Keypair;
  private managerKp: Keypair;
  private vaultPubkey: PublicKey | null = null;

  constructor(adminKey: Uint8Array, managerKey: Uint8Array) {
    this.connection = new Connection(config.solanaRpcUrl);
    this.adminKp = Keypair.fromSecretKey(adminKey);
    this.managerKp = Keypair.fromSecretKey(managerKey);
  }

  async initialize(): Promise<void> {
    this.client = new VoltrClient(this.connection);
    if (config.vaultPubkey) {
      this.vaultPubkey = new PublicKey(config.vaultPubkey);
    }
    logger.info("Ranger vault manager initialized");
  }

  async createVault(): Promise<PublicKey> {
    const vaultKp = Keypair.generate();

    const ix = await this.client.createInitializeVaultIx(
      {
        config: {
          maxCap: new BN("18446744073709551615"), // u64 max = uncapped
          startAtTs: new BN(0),
          lockedProfitDegradationDuration: new BN(86400),
          managerPerformanceFee: 2000, // 20%
          adminPerformanceFee: 0,
          managerManagementFee: 100, // 1%
          adminManagementFee: 0,
          redemptionFee: 0,
          issuanceFee: 0,
          withdrawalWaitingPeriod: new BN(3600),
        },
        name: "AI Delta-Neutral Vault",
        description: "AI-powered USDC delta-neutral funding harvester",
      },
      {
        vault: vaultKp.publicKey,
        vaultAssetMint: new PublicKey(USDC_MINT),
        admin: this.adminKp.publicKey,
        manager: this.managerKp.publicKey,
        payer: this.adminKp.publicKey,
      }
    );

    const sig = await sendIx(this.connection, ix, [this.adminKp, vaultKp]);
    this.vaultPubkey = vaultKp.publicKey;

    logger.info("Vault created", {
      vaultPubkey: vaultKp.publicKey.toBase58(),
      txSignature: sig,
    });

    return vaultKp.publicKey;
  }

  async addDriftAdaptor(): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const ix = await this.client.createAddAdaptorIx({
      vault: this.vaultPubkey,
      admin: this.adminKp.publicKey,
      payer: this.adminKp.publicKey,
      adaptorProgram: new PublicKey(config.programs.driftAdaptor),
    });

    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("Drift adaptor added to vault", { txSignature: sig });
  }

  async getVaultState(): Promise<{
    totalValue: Decimal;
    sharePrice: Decimal;
    strategies: any[];
  }> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const { totalValue, strategies } =
      await this.client.getPositionAndTotalValuesForVault(this.vaultPubkey);
    const sharePrice =
      await this.client.getCurrentAssetPerLpForVault(this.vaultPubkey);

    return {
      totalValue: new Decimal(totalValue.toString()).div(1e6),
      sharePrice: new Decimal(sharePrice.toString()),
      strategies,
    };
  }

  // ── Strategy initialization ───────────────────────────────────────────────

  /**
   * Initialize the Drift strategy on the vault. One-time call per vault.
   *
   * Uses strategy seed "drift_user_curve" (perps/margin variant).
   * additionalArgs = vault name bytes + enableMarginTrading byte.
   * Must create the vaultStrategyAuth ATA before the init IX.
   */
  async initializeDriftStrategy(): Promise<{
    strategyPubkey: PublicKey;
    driftUser: PublicKey;
    txSignature: string;
  }> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const driftAdaptorProgram = new PublicKey(config.programs.driftAdaptor);
    const driftProgram        = new PublicKey(DRIFT_PROGRAM_ID);

    // Strategy PDA — seed: ["drift_user_curve"] (no vault buffer), from adaptor program
    const [strategy] = PublicKey.findProgramAddressSync(
      [Buffer.from("drift_user_curve")],
      driftAdaptorProgram
    );

    const { vaultStrategyAuth } = this.client.findVaultStrategyAddresses(
      this.vaultPubkey,
      strategy
    );

    const { userStats, user } = driftPDAs(vaultStrategyAuth, driftProgram, SUB_ACCOUNT_ID);

    let transactionIxs: TransactionInstruction[] = [];

    // Must create vaultStrategyAuth ATA before init
    await setupTokenAccount(
      this.connection,
      this.adminKp.publicKey,
      new PublicKey(USDC_MINT),
      vaultStrategyAuth,
      transactionIxs,
      TOKEN_PROGRAM_ID
    );

    // additionalArgs: vault name bytes + enableMarginTrading byte
    const vaultAccount   = await this.client.fetchVaultAccount(this.vaultPubkey);
    const vaultName      = Buffer.from(vaultAccount.name);
    const marginFlag     = Buffer.from(ENABLE_MARGIN ? [1] : [0]);
    const additionalArgs = Buffer.concat([vaultName, marginFlag], vaultName.length + marginFlag.length);

    // Remaining accounts order (from voltrxyz/drift-scripts/manager-init-user.ts):
    // [protocolProgram, userStats (w), user (w), state (w), delegatee, SYSVAR_RENT]
    const initIx = await this.client.createInitializeStrategyIx(
      {
        instructionDiscriminator: DISCRIMINATOR_INITIALIZE_USER,
        additionalArgs,
      },
      {
        payer:   this.adminKp.publicKey,
        vault:   this.vaultPubkey,
        manager: this.managerKp.publicKey,
        strategy,
        remainingAccounts: [
          { pubkey: driftProgram,                  isSigner: false, isWritable: false },
          { pubkey: userStats,                     isSigner: false, isWritable: true  },
          { pubkey: user,                          isSigner: false, isWritable: true  },
          { pubkey: new PublicKey(DRIFT_STATE),    isSigner: false, isWritable: true  },
          { pubkey: this.managerKp.publicKey,      isSigner: false, isWritable: false }, // delegatee
          { pubkey: SYSVAR_RENT_PUBKEY,            isSigner: false, isWritable: false },
        ],
        adaptorProgram: driftAdaptorProgram,
      }
    );

    transactionIxs.push(initIx);

    const sig = await sendAndConfirmOptimisedTx(
      transactionIxs,
      config.heliusRpcUrl,
      this.adminKp
    );

    logger.info("Drift strategy initialized", {
      strategyPubkey: strategy.toBase58(),
      driftUser: user.toBase58(),
      txSignature: sig,
    });

    return { strategyPubkey: strategy, driftUser: user, txSignature: sig };
  }

  /**
   * Initialize a Kamino KVault lending strategy on the vault. One-time call.
   *
   * KVault: the strategy PDA is derived from [SEEDS.STRATEGY, kvault.toBuffer()]
   * with the lending adaptor program. Remaining accounts = [] (Kamino handles
   * its own PDAs internally).
   *
   * The `kvault` address is the Kamino vault pubkey for the specific market
   * (e.g. USDC main market). Run `scripts/init-kamino-strategy.ts` to discover
   * the correct kvault address before calling this.
   *
   * Source: voltrxyz/kamino-scripts manager-initialize-kvault.ts
   */
  async initializeKaminoStrategy(kvault: PublicKey): Promise<{
    strategyPubkey: PublicKey;
    txSignature: string;
  }> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const lendingAdaptorProgram = new PublicKey(config.programs.lendingAdaptor);

    // KVault strategy PDA: [SEEDS.STRATEGY, kvault.toBuffer()] with adaptor
    const [strategy] = PublicKey.findProgramAddressSync(
      [Buffer.from("strategy"), kvault.toBuffer()],
      lendingAdaptorProgram
    );

    const { vaultStrategyAuth } = this.client.findVaultStrategyAddresses(
      this.vaultPubkey,
      strategy
    );

    let transactionIxs: TransactionInstruction[] = [];

    // Create vaultStrategyAuth ATA for the asset before init
    await setupTokenAccount(
      this.connection,
      this.adminKp.publicKey,
      new PublicKey(USDC_MINT),
      vaultStrategyAuth,
      transactionIxs,
      TOKEN_PROGRAM_ID
    );

    // Discriminator from voltrxyz/kamino-scripts/src/constants/kamino.ts
    const DISCRIMINATOR_INITIALIZE_KVAULT = Buffer.from([48, 191, 163, 44, 71, 129, 63, 164]);

    const initIx = await this.client.createInitializeStrategyIx(
      { instructionDiscriminator: DISCRIMINATOR_INITIALIZE_KVAULT },
      {
        payer:   this.adminKp.publicKey,
        vault:   this.vaultPubkey,
        manager: this.managerKp.publicKey,
        strategy,
        adaptorProgram: lendingAdaptorProgram,
        remainingAccounts: [], // KVault uses empty remaining accounts
      }
    );

    transactionIxs.push(initIx);

    const sig = await sendAndConfirmOptimisedTx(
      transactionIxs,
      config.heliusRpcUrl,
      this.adminKp
    );

    logger.info("Kamino KVault strategy initialized", {
      strategyPubkey: strategy.toBase58(),
      kvault: kvault.toBase58(),
      txSignature: sig,
    });

    return { strategyPubkey: strategy, txSignature: sig };
  }

  // ── Strategy capital allocation ───────────────────────────────────────────

  /**
   * Move USDC from vault idle → Drift user account.
   * Strategy seed: "drift_user" (spot operations variant).
   * Uses DriftClient.getUserAccountsForAuthority for full remaining accounts.
   */
  async depositToStrategy(
    _strategyPubkey: PublicKey, // kept for API compatibility; internally derived
    amount: Decimal
  ): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const driftAdaptorProgram = new PublicKey(config.programs.driftAdaptor);
    const driftProgram        = new PublicKey(DRIFT_PROGRAM_ID);
    const depositAmount       = new BN(amount.mul(new Decimal(1e6)).toFixed(0));

    // Deposit uses "drift_user" seed
    const [strategy] = PublicKey.findProgramAddressSync(
      [Buffer.from("drift_user")],
      driftAdaptorProgram
    );

    const { vaultStrategyAuth } = this.client.findVaultStrategyAddresses(
      this.vaultPubkey,
      strategy
    );

    const { userStats, user } = driftPDAs(vaultStrategyAuth, driftProgram, SUB_ACCOUNT_ID);
    const counterPartyTa      = driftCounterPartyTa(driftProgram, USDC_MARKET_INDEX);

    let transactionIxs: TransactionInstruction[] = [];

    await setupTokenAccount(
      this.connection,
      this.managerKp.publicKey,
      new PublicKey(USDC_MINT),
      vaultStrategyAuth,
      transactionIxs,
      TOKEN_PROGRAM_ID
    );

    // Short-lived DriftClient to fetch remaining accounts
    const driftClient = new DriftClient({
      connection: this.connection as any,
      wallet: new Wallet(this.managerKp),
      env: "mainnet-beta",
      skipLoadUsers: true,
    });
    await driftClient.subscribe();
    const userAccounts = await driftClient.getUserAccountsForAuthority(vaultStrategyAuth);
    const driftRemainingAccounts = driftClient.getRemainingAccounts({
      userAccounts,
      useMarketLastSlotCache: false,
      writableSpotMarketIndexes: [USDC_MARKET_INDEX],
    });
    await driftClient.unsubscribe();

    // Order (from voltrxyz/drift-scripts/manager-deposit-user.ts):
    // [counterPartyTa (w), protocolProgram, userStats (w), user (w), state, ...driftRemaining]
    const remainingAccounts = [
      { pubkey: counterPartyTa,              isSigner: false, isWritable: true  },
      { pubkey: driftProgram,                isSigner: false, isWritable: false },
      { pubkey: userStats,                   isSigner: false, isWritable: true  },
      { pubkey: user,                        isSigner: false, isWritable: true  },
      { pubkey: new PublicKey(DRIFT_STATE),  isSigner: false, isWritable: false },
      ...driftRemainingAccounts,
    ];

    const additionalArgs = Buffer.from([
      ...new BN(USDC_MARKET_INDEX).toArrayLike(Buffer, "le", 2),
    ]);

    const depositIx = await this.client.createDepositStrategyIx(
      {
        instructionDiscriminator: DISCRIMINATOR_DEPOSIT_USER,
        depositAmount,
        additionalArgs,
      },
      {
        manager: this.managerKp.publicKey,
        vault:   this.vaultPubkey,
        vaultAssetMint: new PublicKey(USDC_MINT),
        assetTokenProgram: TOKEN_PROGRAM_ID,
        strategy,
        remainingAccounts,
        adaptorProgram: driftAdaptorProgram,
      }
    );

    transactionIxs.push(depositIx);

    const lutAccounts = await getAddressLookupTableAccounts(
      [DRIFT_LUT],
      this.connection
    );

    const sig = await sendAndConfirmOptimisedTx(
      transactionIxs,
      config.heliusRpcUrl,
      this.managerKp,
      [],
      lutAccounts
    );

    logger.info(`Deposited $${amount.toFixed(2)} to Drift strategy`, {
      strategy: strategy.toBase58(),
      txSignature: sig,
    });
  }

  /**
   * Move USDC from Drift user account → vault idle.
   * Strategy seed: "drift_user" (same as deposit).
   * Withdraw adds driftSigner as the first remaining account.
   */
  async withdrawFromStrategy(
    _strategyPubkey: PublicKey, // kept for API compatibility; internally derived
    amount: Decimal
  ): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const driftAdaptorProgram = new PublicKey(config.programs.driftAdaptor);
    const driftProgram        = new PublicKey(DRIFT_PROGRAM_ID);
    const withdrawAmount      = new BN(amount.mul(new Decimal(1e6)).toFixed(0));

    // Withdraw uses "drift_user" seed (same as deposit)
    const [strategy] = PublicKey.findProgramAddressSync(
      [Buffer.from("drift_user")],
      driftAdaptorProgram
    );

    const { vaultStrategyAuth } = this.client.findVaultStrategyAddresses(
      this.vaultPubkey,
      strategy
    );

    const { userStats, user } = driftPDAs(vaultStrategyAuth, driftProgram, SUB_ACCOUNT_ID);
    const counterPartyTa      = driftCounterPartyTa(driftProgram, USDC_MARKET_INDEX);

    // driftSigner PDA: ["drift_signer"] in Drift program (withdraw only)
    const [driftSigner] = PublicKey.findProgramAddressSync(
      [Buffer.from("drift_signer")],
      driftProgram
    );

    let transactionIxs: TransactionInstruction[] = [];

    await setupTokenAccount(
      this.connection,
      this.managerKp.publicKey,
      new PublicKey(USDC_MINT),
      vaultStrategyAuth,
      transactionIxs,
      TOKEN_PROGRAM_ID
    );

    // Short-lived DriftClient to fetch remaining accounts
    const driftClient = new DriftClient({
      connection: this.connection as any,
      wallet: new Wallet(this.managerKp),
      env: "mainnet-beta",
      skipLoadUsers: true,
    });
    await driftClient.subscribe();
    const userAccounts = await driftClient.getUserAccountsForAuthority(vaultStrategyAuth);
    const driftRemainingAccounts = driftClient.getRemainingAccounts({
      userAccounts,
      useMarketLastSlotCache: false,
      writableSpotMarketIndexes: [USDC_MARKET_INDEX],
    });
    await driftClient.unsubscribe();

    // Order (from voltrxyz/drift-scripts/manager-withdraw-user.ts):
    // [driftSigner (w), counterPartyTa (w), protocolProgram, userStats (w), user (w), state, ...driftRemaining]
    const remainingAccounts = [
      { pubkey: driftSigner,                 isSigner: false, isWritable: true  },
      { pubkey: counterPartyTa,              isSigner: false, isWritable: true  },
      { pubkey: driftProgram,                isSigner: false, isWritable: false },
      { pubkey: userStats,                   isSigner: false, isWritable: true  },
      { pubkey: user,                        isSigner: false, isWritable: true  },
      { pubkey: new PublicKey(DRIFT_STATE),  isSigner: false, isWritable: false },
      ...driftRemainingAccounts,
    ];

    const additionalArgs = Buffer.from([
      ...new BN(USDC_MARKET_INDEX).toArrayLike(Buffer, "le", 2),
    ]);

    const withdrawIx = await this.client.createWithdrawStrategyIx(
      {
        instructionDiscriminator: DISCRIMINATOR_WITHDRAW_USER,
        withdrawAmount,
        additionalArgs,
      },
      {
        manager: this.managerKp.publicKey,
        vault:   this.vaultPubkey,
        vaultAssetMint: new PublicKey(USDC_MINT),
        assetTokenProgram: TOKEN_PROGRAM_ID,
        strategy,
        remainingAccounts,
        adaptorProgram: driftAdaptorProgram,
      }
    );

    transactionIxs.push(withdrawIx);

    const lutAccounts = await getAddressLookupTableAccounts(
      [DRIFT_LUT],
      this.connection
    );

    const sig = await sendAndConfirmOptimisedTx(
      transactionIxs,
      config.heliusRpcUrl,
      this.managerKp,
      [],
      lutAccounts
    );

    logger.info(`Withdrew $${amount.toFixed(2)} from Drift strategy`, {
      strategy: strategy.toBase58(),
      txSignature: sig,
    });
  }

  /**
   * Check total pending withdrawal requests and vault idle balance.
   * Returns how much USDC needs to be pulled back from Drift to cover withdrawals.
   */
  async getPendingWithdrawalRisk(): Promise<{
    totalPendingUsdc: Decimal;
    idleUsdc: Decimal;
    shortfallUsdc: Decimal;
    atRisk: boolean;
  }> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const withdrawals = await this.client.getAllPendingWithdrawalsForVault(
      this.vaultPubkey
    );
    const totalPending = withdrawals.reduce(
      (sum: BN, w: any) =>
        sum.add(new BN(w.amountAssetToWithdraw?.toString() ?? "0")),
      new BN(0)
    );
    const totalPendingUsdc = new Decimal(totalPending.toString()).div(1e6);

    // Idle USDC = vault asset idle ATA balance
    const { vaultAssetIdleAuth } = this.client.findVaultAddresses(this.vaultPubkey);
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const idleAta = getAssociatedTokenAddressSync(
      new PublicKey(USDC_MINT),
      vaultAssetIdleAuth,
      true
    );
    let idleUsdc = new Decimal(0);
    try {
      const bal = await this.connection.getTokenAccountBalance(idleAta);
      idleUsdc = new Decimal(bal.value.amount).div(1e6);
    } catch {
      // ATA may not exist yet (empty vault)
    }

    const shortfallUsdc = Decimal.max(
      totalPendingUsdc.sub(idleUsdc),
      new Decimal(0)
    );

    return {
      totalPendingUsdc,
      idleUsdc,
      shortfallUsdc,
      atRisk: shortfallUsdc.gt(0),
    };
  }

  async harvestFees(): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const managerFees =
      await this.client.getAccumulatedManagerFeesForVault(this.vaultPubkey);
    logger.info(`Manager fees accumulated: ${managerFees.toString()}`);

    const ix = await this.client.createHarvestFeeIx({
      vault:        this.vaultPubkey,
      harvester:    this.managerKp.publicKey,
      vaultManager: this.managerKp.publicKey,
      vaultAdmin:   this.adminKp.publicKey,
      protocolAdmin: this.adminKp.publicKey,
    });

    const sig = await sendIx(this.connection, ix, [this.managerKp]);
    logger.info("Fees harvested", { txSignature: sig });
  }

  // ── Vault config updates ─────────────────────────────────────────────────

  async updateMaxCap(maxCap: BN): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.MaxCap,
      maxCap.toArrayLike(Buffer, "le", 8),
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("MaxCap updated", { maxCap: maxCap.toString(), txSignature: sig });
    return sig;
  }

  async updateWithdrawalWaitingPeriod(seconds: BN): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.WithdrawalWaitingPeriod,
      seconds.toArrayLike(Buffer, "le", 8),
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("WithdrawalWaitingPeriod updated", { seconds: seconds.toString(), txSignature: sig });
    return sig;
  }

  async updateLockedProfitDegradationDuration(seconds: BN): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.LockedProfitDegradationDuration,
      seconds.toArrayLike(Buffer, "le", 8),
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("LockedProfitDegradationDuration updated", { seconds: seconds.toString(), txSignature: sig });
    return sig;
  }

  async updateFee(field: VaultConfigField, basisPoints: number): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const feeData = Buffer.alloc(2);
    feeData.writeUInt16LE(basisPoints, 0);
    const accounts: any = { vault: this.vaultPubkey, admin: this.adminKp.publicKey };
    if (
      field === VaultConfigField.ManagerManagementFee ||
      field === VaultConfigField.AdminManagementFee
    ) {
      accounts.vaultLpMint = this.client.findVaultLpMint(this.vaultPubkey);
    }
    const ix = await this.client.createUpdateVaultConfigIx(field, feeData, accounts);
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info(`Fee updated`, { field, basisPoints, txSignature: sig });
    return sig;
  }

  async updateManager(newManagerPubkey: PublicKey): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.Manager,
      newManagerPubkey.toBuffer(),
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("Manager updated", { newManager: newManagerPubkey.toBase58(), txSignature: sig });
    return sig;
  }

  getVaultPubkey(): PublicKey | null {
    return this.vaultPubkey;
  }

  getClient(): VoltrClient {
    return this.client;
  }
}
