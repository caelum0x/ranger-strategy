import { VoltrClient, VaultConfigField } from "@voltr/vault-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getUserAccountPublicKeySync,
  getUserStatsAccountPublicKey,
  getDriftStateAccountPublicKey,
} from "@drift-labs/sdk";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import { config } from "../config";
import { logger } from "../utils/logger";

async function sendIx(
  connection: Connection,
  ix: any,
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

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

    const USDC_MINT = new PublicKey(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );

    const vaultConfig = {
      maxCap: new BN("18446744073709551615"), // uncapped
      startAtTs: new BN(0), // immediate
      lockedProfitDegradationDuration: new BN(86400), // 24h
      managerPerformanceFee: 2000, // 20% performance fee
      adminPerformanceFee: 0,
      managerManagementFee: 100, // 1% management fee
      adminManagementFee: 0,
      redemptionFee: 0,
      issuanceFee: 0,
      withdrawalWaitingPeriod: new BN(3600), // 1 hour
    };

    const ix = await this.client.createInitializeVaultIx(
      {
        config: vaultConfig,
        name: "AI Delta-Neutral Vault",
        description: "AI-powered USDC delta-neutral funding harvester",
      },
      {
        vault: vaultKp.publicKey,
        vaultAssetMint: USDC_MINT,
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

    const driftAdaptorProgram = new PublicKey(config.programs.driftAdaptor);

    const ix = await this.client.createAddAdaptorIx({
      vault: this.vaultPubkey,
      admin: this.adminKp.publicKey,
      payer: this.adminKp.publicKey,
      adaptorProgram: driftAdaptorProgram,
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

    const vaultAccount = await this.client.fetchVaultAccount(this.vaultPubkey);
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

  async depositToStrategy(
    strategyPubkey: PublicKey,
    amount: Decimal
  ): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const lamportAmount = new BN(
      amount.mul(new Decimal(10).pow(6)).toFixed(0)
    );

    const ix = await this.client.createDepositStrategyIx(
      { depositAmount: lamportAmount },
      {
        vault: this.vaultPubkey,
        strategy: strategyPubkey,
        manager: this.managerKp.publicKey,
      } as any
    );

    const sig = await sendIx(this.connection, ix, [this.managerKp]);
    logger.info(`Deposited $${amount.toFixed(2)} to strategy`, {
      strategy: strategyPubkey.toBase58(),
      txSignature: sig,
    });
  }

  async withdrawFromStrategy(
    strategyPubkey: PublicKey,
    amount: Decimal
  ): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const lamportAmount = new BN(
      amount.mul(new Decimal(10).pow(6)).toFixed(0)
    );

    const ix = await this.client.createWithdrawStrategyIx(
      { withdrawAmount: lamportAmount },
      {
        vault: this.vaultPubkey,
        strategy: strategyPubkey,
        manager: this.managerKp.publicKey,
      } as any
    );

    const sig = await sendIx(this.connection, ix, [this.managerKp]);
    logger.info(`Withdrew $${amount.toFixed(2)} from strategy`, {
      strategy: strategyPubkey.toBase58(),
      txSignature: sig,
    });
  }

  async harvestFees(): Promise<void> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const managerFees =
      await this.client.getAccumulatedManagerFeesForVault(this.vaultPubkey);
    logger.info(`Manager fees accumulated: ${managerFees.toString()}`);

    const ix = await this.client.createHarvestFeeIx({
      vault: this.vaultPubkey,
      harvester: this.managerKp.publicKey,
      vaultManager: this.managerKp.publicKey,
      vaultAdmin: this.adminKp.publicKey,
      protocolAdmin: this.adminKp.publicKey,
    });

    const sig = await sendIx(this.connection, ix, [this.managerKp]);
    logger.info("Fees harvested", { txSignature: sig });
  }

  // ── Vault config updates ─────────────────────────────────────────────────

  async updateMaxCap(maxCap: BN): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const data = maxCap.toArrayLike(Buffer, "le", 8);
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.MaxCap,
      data,
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("MaxCap updated", { maxCap: maxCap.toString(), txSignature: sig });
    return sig;
  }

  async updateWithdrawalWaitingPeriod(seconds: BN): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const data = seconds.toArrayLike(Buffer, "le", 8);
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.WithdrawalWaitingPeriod,
      data,
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("WithdrawalWaitingPeriod updated", { seconds: seconds.toString(), txSignature: sig });
    return sig;
  }

  async updateLockedProfitDegradationDuration(seconds: BN): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const data = seconds.toArrayLike(Buffer, "le", 8);
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.LockedProfitDegradationDuration,
      data,
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("LockedProfitDegradationDuration updated", { seconds: seconds.toString(), txSignature: sig });
    return sig;
  }

  /** Update a fee field (basis points, u16). Use for performance, redemption, and issuance fees. */
  async updateFee(field: VaultConfigField, basisPoints: number): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const feeData = Buffer.alloc(2);
    feeData.writeUInt16LE(basisPoints, 0);

    const accounts: any = { vault: this.vaultPubkey, admin: this.adminKp.publicKey };

    // Management fee updates require the LP mint
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

  /** Transfer manager authority to a new keypair. Irreversible without new manager's cooperation. */
  async updateManager(newManagerPubkey: PublicKey): Promise<string> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");
    const managerData = newManagerPubkey.toBuffer();
    const ix = await this.client.createUpdateVaultConfigIx(
      VaultConfigField.Manager,
      managerData,
      { vault: this.vaultPubkey, admin: this.adminKp.publicKey }
    );
    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("Manager updated", { newManager: newManagerPubkey.toBase58(), txSignature: sig });
    return sig;
  }

  // ── Strategy initialization ───────────────────────────────────────────────

  /**
   * Initialize a Drift strategy on the vault. One-time call per vault.
   *
   * Creates the Drift user account that the vault will trade through.
   * Must be called after `addDriftAdaptor()`.
   * The manager keypair is set as the delegatee (can place trades on behalf of the vault).
   *
   * @returns { strategyPubkey, driftUser, txSignature }
   */
  async initializeDriftStrategy(): Promise<{
    strategyPubkey: PublicKey;
    driftUser: PublicKey;
    txSignature: string;
  }> {
    if (!this.vaultPubkey) throw new Error("Vault not initialized");

    const DRIFT_PROGRAM_ID = new PublicKey(
      "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
    );
    const driftAdaptorProgram = new PublicKey(config.programs.driftAdaptor);

    // Discriminator for the adaptor's initialize instruction (from voltrxyz/drift-scripts)
    const INIT_DISCRIMINATOR = Buffer.from([200, 103, 130, 67, 230, 84, 7, 225]);

    // Strategy PDA — seed: ["drift_user", vault] with drift adaptor program
    const [strategy] = PublicKey.findProgramAddressSync(
      [Buffer.from("drift_user"), this.vaultPubkey.toBuffer()],
      driftAdaptorProgram
    );

    // Vault-strategy authority — the on-chain signer for the vault's Drift account
    const vaultStrategyAuth = this.client.findVaultStrategyAuth(
      this.vaultPubkey,
      strategy
    );

    // Drift PDAs
    const driftUser = getUserAccountPublicKeySync(
      DRIFT_PROGRAM_ID,
      vaultStrategyAuth,
      0 // sub-account 0
    );
    const driftUserStats = getUserStatsAccountPublicKey(
      DRIFT_PROGRAM_ID,
      vaultStrategyAuth
    );
    const driftState = await getDriftStateAccountPublicKey(DRIFT_PROGRAM_ID);

    const ix = await this.client.createInitializeStrategyIx(
      { instructionDiscriminator: INIT_DISCRIMINATOR } as any,
      {
        payer: this.adminKp.publicKey,
        manager: this.managerKp.publicKey,
        vault: this.vaultPubkey,
        strategy,
        adaptorProgram: driftAdaptorProgram,
        remainingAccounts: [
          { pubkey: DRIFT_PROGRAM_ID,           isSigner: false, isWritable: false },
          { pubkey: driftUserStats,             isSigner: false, isWritable: true  },
          { pubkey: driftUser,                  isSigner: false, isWritable: true  },
          { pubkey: driftState,                 isSigner: false, isWritable: true  },
          { pubkey: this.managerKp.publicKey,   isSigner: false, isWritable: false }, // delegatee
          { pubkey: SYSVAR_RENT_PUBKEY,         isSigner: false, isWritable: false },
        ],
      }
    );

    const sig = await sendIx(this.connection, ix, [this.adminKp]);
    logger.info("Drift strategy initialized", {
      strategyPubkey: strategy.toBase58(),
      driftUser: driftUser.toBase58(),
      txSignature: sig,
    });

    return { strategyPubkey: strategy, driftUser, txSignature: sig };
  }

  getVaultPubkey(): PublicKey | null {
    return this.vaultPubkey;
  }

  getClient(): VoltrClient {
    return this.client;
  }
}
