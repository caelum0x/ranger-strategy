/**
 * Voltr Vault Strategy Client — REAL @voltr/vault-sdk integration.
 *
 * Manages strategy-level deposits, withdrawals, and position queries
 * for Ranger Earn vaults using the actual Voltr SDK.
 *
 * Ported from: voltr-plugin/tools/voltr_deposit_strategy.ts + voltr_withdraw_strategy.ts
 * Fixed gaps: deposit/withdraw now build real instructions via SDK.
 */
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { VoltrClient as VoltrSDK } from "@voltr/vault-sdk";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface VoltrStrategyPosition {
  strategyAddress: string;
  depositedAmount: number;
  currentValue: number;
  apy: number;
}

export interface VaultInfo {
  address: string;
  totalValue: number;
  idleBalance: number;
  strategyCount: number;
  lpSupply: number;
  sharePrice: number;
}

const VOLTR_API = "https://app.voltr.xyz";

// ── Client ──────────────────────────────────────────────────────

export class VoltrClient {
  private connection: Connection;
  private sdk: VoltrSDK;

  constructor(connection: Connection) {
    this.connection = connection;
    this.sdk = new VoltrSDK(connection);
  }

  // ── Strategy Deposit (REAL SDK — from voltr-plugin) ───────────

  /**
   * Deposit vault assets into a strategy via Voltr SDK.
   * From: voltr-plugin/tools/voltr_deposit_strategy.ts
   *
   * Uses @voltr/vault-sdk createDepositStrategyIx with dynamic
   * remaining accounts fetched from the Voltr API.
   */
  async depositStrategy(
    vaultAddress: PublicKey,
    strategyAddress: PublicKey,
    amount: BN,
    manager: Keypair,
    assetMint: PublicKey,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    logger.info("Voltr: depositing into strategy", {
      vault: vaultAddress.toBase58().slice(0, 8),
      strategy: strategyAddress.toBase58().slice(0, 8),
      amount: amount.toString(),
    });

    // Fetch remaining accounts from Voltr API (dynamic per strategy)
    const apiResponse = await fetch(
      `${VOLTR_API}/api/v1/vault_deposit_strategy/${vaultAddress.toBase58()}/${strategyAddress.toBase58()}`
    );
    if (!apiResponse.ok) {
      throw new Error(`Voltr API deposit failed: ${apiResponse.status}`);
    }
    const apiData = (await apiResponse.json()) as any;
    const remainingAccounts = apiData.remainingAccounts || [];
    const additionalArgs = apiData.additionalArgs || {};

    // Build deposit strategy instruction using SDK
    const ix = await this.sdk.createDepositStrategyIx(
      {
        depositAmount: amount,
        instructionDiscriminator: additionalArgs.instructionDiscriminator,
        additionalArgs: additionalArgs.additionalArgs || Buffer.alloc(0),
      },
      {
        manager: manager.publicKey,
        vault: vaultAddress,
        vaultAssetMint: assetMint,
        strategy: strategyAddress,
        assetTokenProgram,
        adaptorProgram: remainingAccounts[0]?.pubkey || assetTokenProgram,
        remainingAccounts,
      }
    );

    // Build and send transaction
    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: manager.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([manager]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: deposit strategy tx sent", { txSig });
    return txSig;
  }

  // ── Strategy Withdraw (REAL SDK — from voltr-plugin) ──────────

  /**
   * Withdraw vault assets from a strategy via Voltr SDK.
   * From: voltr-plugin/tools/voltr_withdraw_strategy.ts
   */
  async withdrawStrategy(
    vaultAddress: PublicKey,
    strategyAddress: PublicKey,
    amount: BN,
    manager: Keypair,
    assetMint: PublicKey,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    logger.info("Voltr: withdrawing from strategy", {
      vault: vaultAddress.toBase58().slice(0, 8),
      strategy: strategyAddress.toBase58().slice(0, 8),
      amount: amount.toString(),
    });

    const apiResponse = await fetch(
      `${VOLTR_API}/api/v1/vault_withdraw_strategy/${vaultAddress.toBase58()}/${strategyAddress.toBase58()}`
    );
    if (!apiResponse.ok) {
      throw new Error(`Voltr API withdraw failed: ${apiResponse.status}`);
    }
    const apiData = (await apiResponse.json()) as any;
    const remainingAccounts = apiData.remainingAccounts || [];
    const additionalArgs = apiData.additionalArgs || {};

    const ix = await this.sdk.createWithdrawStrategyIx(
      {
        withdrawAmount: amount,
        instructionDiscriminator: additionalArgs.instructionDiscriminator,
        additionalArgs: additionalArgs.additionalArgs || Buffer.alloc(0),
      },
      {
        manager: manager.publicKey,
        vault: vaultAddress,
        vaultAssetMint: assetMint,
        strategy: strategyAddress,
        assetTokenProgram,
        adaptorProgram: remainingAccounts[0]?.pubkey || assetTokenProgram,
        remainingAccounts,
      }
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: manager.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([manager]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: withdraw strategy tx sent", { txSig });
    return txSig;
  }

  // ── Position Values (REAL SDK — from voltr-plugin) ────────────

  /**
   * Get position values for all strategies in a vault.
   * Uses @voltr/vault-sdk for on-chain reads (more reliable than REST).
   * From: voltr-plugin/tools/voltr_get_position_values.ts
   */
  async getPositionValues(
    vaultAddress: PublicKey
  ): Promise<{ positions: VoltrStrategyPosition[]; totalValue: number }> {
    try {
      const result = await (this.sdk as any).getPositionAndTotalValuesForVault(
        vaultAddress
      );
      return {
        positions: (result.positions || []).map((p: any) => ({
          strategyAddress: p.strategyAddress?.toBase58?.() || "",
          depositedAmount: p.depositedAmount || 0,
          currentValue: p.currentValue || 0,
          apy: p.apy || 0,
        })),
        totalValue: result.totalValue || 0,
      };
    } catch {
      // Fallback to REST API
      const response = await fetch(
        `${VOLTR_API}/api/v1/vault/${vaultAddress.toBase58()}/positions`
      );
      if (!response.ok) return { positions: [], totalValue: 0 };
      const data = (await response.json()) as any;
      return {
        positions: data.positions || data || [],
        totalValue: data.totalValue || 0,
      };
    }
  }

  // ── User Vault Operations (from lend-scripts) ─────────────────

  /**
   * Deposit USDC into a Voltr vault as a user (receive LP tokens).
   * From: lend-scripts/src/scripts/user-deposit-vault.ts
   */
  async userDeposit(
    vaultAddress: PublicKey,
    amount: BN,
    user: Keypair,
    assetMint: PublicKey,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    logger.info("Voltr: user depositing into vault", {
      vault: vaultAddress.toBase58().slice(0, 8),
      amount: amount.toString(),
    });

    const ix = await this.sdk.createDepositVaultIx(amount, {
      vault: vaultAddress,
      userTransferAuthority: user.publicKey,
      vaultAssetMint: assetMint,
      assetTokenProgram,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([user]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: user deposit tx sent", { txSig });
    return txSig;
  }

  /**
   * Request withdrawal from a Voltr vault (starts cooldown).
   * From: lend-scripts/src/scripts/user-request-withdraw-vault.ts
   */
  async userRequestWithdraw(
    vaultAddress: PublicKey,
    amount: BN,
    user: Keypair,
    assetMint: PublicKey,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    logger.info("Voltr: user requesting withdrawal", {
      vault: vaultAddress.toBase58().slice(0, 8),
      amount: amount.toString(),
    });

    const ix = await this.sdk.createRequestWithdrawVaultIx(
      { amount, isAmountInLp: false, isWithdrawAll: false },
      {
        payer: user.publicKey,
        userTransferAuthority: user.publicKey,
        vault: vaultAddress,
      }
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([user]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: withdraw request tx sent", { txSig });
    return txSig;
  }

  /**
   * Complete withdrawal from a Voltr vault (after cooldown).
   * From: lend-scripts/src/scripts/user-withdraw-vault.ts
   */
  async userWithdraw(
    vaultAddress: PublicKey,
    user: Keypair,
    assetMint: PublicKey,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    logger.info("Voltr: user completing withdrawal", {
      vault: vaultAddress.toBase58().slice(0, 8),
    });

    const ix = await this.sdk.createWithdrawVaultIx({
      vault: vaultAddress,
      userTransferAuthority: user.publicKey,
      vaultAssetMint: assetMint,
      assetTokenProgram,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([user]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: user withdrawal tx sent", { txSig });
    return txSig;
  }

  // ── Vault Info (from lend-scripts) ────────────────────────────

  /**
   * Get vault info including idle balance and LP supply.
   */
  async getVaultInfo(vaultAddress: PublicKey): Promise<VaultInfo | null> {
    try {
      const vault = await (this.sdk as any).fetchVaultAccount(vaultAddress);
      return {
        address: vaultAddress.toBase58(),
        totalValue: vault.totalValue || 0,
        idleBalance: vault.idleBalance || 0,
        strategyCount: vault.strategies?.length || 0,
        lpSupply: vault.lpSupply || 0,
        sharePrice: vault.lpSupply > 0 ? vault.totalValue / vault.lpSupply : 1,
      };
    } catch {
      return null;
    }
  }

  /**
   * Find the vault's idle asset authority PDA.
   * Used for monitoring new deposits via WebSocket.
   */
  findVaultAssetIdleAuth(vaultAddress: PublicKey): PublicKey {
    return this.sdk.findVaultAssetIdleAuth(vaultAddress);
  }

  /**
   * Admin: harvest accumulated fees from the vault.
   * From: lend-scripts/src/scripts/admin-harvest-fee.ts
   */
  async harvestFees(
    vaultAddress: PublicKey,
    admin: Keypair,
    assetMint: PublicKey,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    const ix = await this.sdk.createHarvestFeeIx({
      vault: vaultAddress,
      harvester: admin.publicKey,
      vaultManager: admin.publicKey,
      vaultAdmin: admin.publicKey,
      protocolAdmin: admin.publicKey,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: admin.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([admin]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: fees harvested", { txSig });
    return txSig;
  }

  // ── Query Methods (SDK) ────────────────────────────────────────

  /**
   * Get high water mark for performance fee tracking.
   */
  async getHighWaterMark(vaultAddress: PublicKey): Promise<{
    highestAssetPerLp: number;
    lastUpdatedTs: number;
  }> {
    return this.sdk.getHighWaterMarkForVault(vaultAddress);
  }

  /**
   * Get LP supply breakdown: circulating, unharvested fees, unrealised fees.
   */
  async getLpSupplyBreakdown(vaultAddress: PublicKey): Promise<{
    circulating: BN;
    unharvestedFees: BN;
    unrealisedFees: BN;
    total: BN;
  }> {
    return this.sdk.getVaultLpSupplyBreakdown(vaultAddress);
  }

  /**
   * Get accumulated fees for admin and manager.
   */
  async getAccumulatedFees(vaultAddress: PublicKey): Promise<{
    adminFees: BN;
    managerFees: BN;
  }> {
    const [adminFees, managerFees] = await Promise.all([
      this.sdk.getAccumulatedAdminFeesForVault(vaultAddress),
      this.sdk.getAccumulatedManagerFeesForVault(vaultAddress),
    ]);
    return { adminFees, managerFees };
  }

  /**
   * Get current share price (asset per LP token).
   */
  async getSharePrice(vaultAddress: PublicKey): Promise<number> {
    return this.sdk.getCurrentAssetPerLpForVault(vaultAddress);
  }

  /**
   * Get all pending withdrawals for a vault.
   */
  async getPendingWithdrawals(vaultAddress: PublicKey): Promise<any[]> {
    return this.sdk.getAllPendingWithdrawalsForVault(vaultAddress);
  }

  /**
   * Get pending withdrawal for a specific user.
   */
  async getPendingWithdrawalForUser(vaultAddress: PublicKey, userPubkey: PublicKey): Promise<any> {
    return this.sdk.getPendingWithdrawalForUser(vaultAddress, userPubkey);
  }

  // ── Calculation Helpers ────────────────────────────────────────

  /**
   * Calculate LP tokens user would receive for a deposit amount.
   */
  async calculateLpForDeposit(vaultAddress: PublicKey, assetAmount: BN): Promise<BN> {
    return this.sdk.calculateLpForDeposit(vaultAddress, assetAmount);
  }

  /**
   * Calculate assets user would receive for burning LP tokens.
   */
  async calculateAssetsForWithdraw(vaultAddress: PublicKey, lpAmount: BN): Promise<BN> {
    return this.sdk.calculateAssetsForWithdraw(vaultAddress, lpAmount);
  }

  /**
   * Calculate LP tokens needed to withdraw a specific asset amount.
   */
  async calculateLpForWithdraw(vaultAddress: PublicKey, assetAmount: BN): Promise<BN> {
    return this.sdk.calculateLpForWithdraw(vaultAddress, assetAmount);
  }

  // ── User Cancel & Instant Withdraw ─────────────────────────────

  /**
   * Cancel a pending withdrawal request.
   */
  async userCancelRequestWithdraw(
    vaultAddress: PublicKey,
    user: Keypair
  ): Promise<string> {
    logger.info("Voltr: user cancelling withdrawal request", {
      vault: vaultAddress.toBase58().slice(0, 8),
    });

    const ix = await this.sdk.createCancelRequestWithdrawVaultIx({
      userTransferAuthority: user.publicKey,
      vault: vaultAddress,
    });

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([user]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: cancel withdraw request tx sent", { txSig });
    return txSig;
  }

  /**
   * Instant withdraw from vault (no waiting period, may have higher fee).
   */
  async userInstantWithdraw(
    vaultAddress: PublicKey,
    amount: BN,
    user: Keypair,
    assetMint: PublicKey,
    isAmountInLp: boolean = false,
    isWithdrawAll: boolean = false,
    assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<string> {
    logger.info("Voltr: user instant withdrawing", {
      vault: vaultAddress.toBase58().slice(0, 8),
      amount: amount.toString(),
    });

    const ix = await this.sdk.createInstantWithdrawVaultIx(
      { amount, isAmountInLp, isWithdrawAll },
      {
        userTransferAuthority: user.publicKey,
        vault: vaultAddress,
        vaultAssetMint: assetMint,
        assetTokenProgram,
      }
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([user]);

    const txSig = await this.connection.sendTransaction(tx);
    logger.info("Voltr: instant withdraw tx sent", { txSig });
    return txSig;
  }

  // ── PDA Finders ────────────────────────────────────────────────

  findVaultLpMint(vaultAddress: PublicKey): PublicKey {
    return this.sdk.findVaultLpMint(vaultAddress);
  }

  findVaultAddresses(vaultAddress: PublicKey) {
    return this.sdk.findVaultAddresses(vaultAddress);
  }

  findVaultStrategyAddresses(vaultAddress: PublicKey, strategy: PublicKey) {
    return this.sdk.findVaultStrategyAddresses(vaultAddress, strategy);
  }

  findRequestWithdrawVaultReceipt(vaultAddress: PublicKey, user: PublicKey): PublicKey {
    return this.sdk.findRequestWithdrawVaultReceipt(vaultAddress, user);
  }

  /**
   * Expose the underlying SDK instance for advanced usage.
   */
  getSDK(): VoltrSDK {
    return this.sdk;
  }
}
