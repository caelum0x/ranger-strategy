import { VoltrClient } from "@voltr/vault-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import { config } from "../config";
import { logger } from "../utils/logger";

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

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.adminKp,
      vaultKp,
    ]);

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

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.adminKp,
    ]);

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

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.managerKp,
    ]);

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

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.managerKp,
    ]);

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

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.managerKp,
    ]);

    logger.info("Fees harvested", { txSignature: sig });
  }

  getVaultPubkey(): PublicKey | null {
    return this.vaultPubkey;
  }

  getClient(): VoltrClient {
    return this.client;
  }
}
