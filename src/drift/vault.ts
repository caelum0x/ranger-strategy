/**
 * Drift Vault Manager — wraps @drift-labs/vaults-sdk VaultClient
 * for creating and managing Drift Protocol vaults.
 *
 * Handles vault lifecycle (init, update, delegate), manager deposits/withdrawals,
 * depositor operations, and vault state queries.
 */
import {
  DriftClient,
  Wallet,
  BN,
  QUOTE_PRECISION,
} from "@drift-labs/sdk";
import {
  VaultClient,
  getDriftVaultProgram,
  encodeName,
  decodeName,
  getVaultAddressSync,
  getVaultDepositorAddressSync,
  WithdrawUnit,
  VAULT_PROGRAM_ID,
} from "@drift-labs/vaults-sdk";
import type {
  Vault,
  VaultDepositor,
  UpdateVaultParams,
} from "@drift-labs/vaults-sdk";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Connection as SolConnection } from "@solana/web3.js";
import Decimal from "decimal.js";
import { config } from "../config";
import { logger } from "../utils/logger";

// ── USDC precision: 1 USDC = 1e6 base units ────────────────────────────
const USDC_PRECISION = new BN(1_000_000);

// ── Public info interfaces ──────────────────────────────────────────────

export interface VaultInfo {
  address: PublicKey;
  name: string;
  manager: PublicKey;
  delegate: PublicKey;
  /** The vault's Drift user account (trade on behalf of this account as delegate) */
  user: PublicKey;
  spotMarketIndex: number;
  userShares: BN;
  totalShares: BN;
  redeemPeriod: number;
  maxTokens: BN;
  minDepositAmount: BN;
  managementFee: BN;
  profitShare: number;
  hurdleRate: number;
  permissioned: boolean;
  netDeposits: BN;
  totalDeposits: BN;
  totalWithdraws: BN;
  /** Total outstanding withdrawal requests — monitor to prevent liquidation takeover */
  totalWithdrawRequested: BN;
  managerTotalDeposits: BN;
  managerTotalWithdraws: BN;
  managerTotalFee: BN;
  managerTotalProfitShare: BN;
  lastManagerWithdrawRequest: {
    shares: BN;
    value: BN;
    ts: BN;
  };
  initTs: BN;
}

export interface DepositorInfo {
  address: PublicKey;
  vault: PublicKey;
  authority: PublicKey;
  vaultShares: BN;
  netDeposits: BN;
  totalDeposits: BN;
  totalWithdraws: BN;
  lastWithdrawRequest: {
    shares: BN;
    value: BN;
    ts: BN;
  };
}

// ── DriftVaultManager ───────────────────────────────────────────────────

export class DriftVaultManager {
  private driftClient: DriftClient;
  private wallet: Wallet;
  private connection: SolConnection;
  private vaultClient!: VaultClient;
  // Using `any` for program type to avoid duplicate Anchor type conflicts
  // across different SDK versions (same pattern as client.ts)
  private program!: any;
  private initialized = false;

  constructor(driftClient: DriftClient, wallet: Wallet) {
    this.driftClient = driftClient;
    this.wallet = wallet;

    // Derive connection from the DriftClient provider (same pattern as client.ts)
    const { Connection } = require("@solana/web3.js");
    this.connection = new Connection(
      config.solanaRpcUrl,
      "confirmed"
    ) as SolConnection;
  }

  // ── Initialization ──────────────────────────────────────────────────

  /**
   * Creates the Anchor Program and VaultClient.
   * Must be called before any other method.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn("DriftVaultManager already initialized");
      return;
    }

    // Build Anchor provider from connection + wallet
    const provider = new AnchorProvider(
      this.connection as any,
      this.wallet as any,
      { commitment: "confirmed" }
    );

    // Let the vault SDK construct the Program with the Anchor version it expects.
    this.program = getDriftVaultProgram(
      this.connection as any,
      this.wallet as any
    ) as any;

    // Create VaultClient — cast driftClient and program to `any` to bridge
    // the type mismatch between different @drift-labs/sdk versions
    this.vaultClient = new VaultClient({
      driftClient: this.driftClient as any,
      program: this.program as any,
      cliMode: true,
    });

    this.initialized = true;

    logger.info("DriftVaultManager initialized", {
      programId: VAULT_PROGRAM_ID.toBase58(),
      wallet: this.wallet.publicKey.toBase58(),
    });
  }

  // ── Vault Lifecycle ─────────────────────────────────────────────────

  /**
   * Initialize a new vault on the Drift Vaults program.
   */
  async initializeVault(params: {
    name: string;
    spotMarketIndex?: number;
    redeemPeriod?: number;
    maxTokens?: number;
    minDepositAmount?: number;
    managementFee?: number;
    profitShare?: number;
    permissioned?: boolean;
  }): Promise<{ vaultAddress: PublicKey; txSig: string }> {
    this.ensureInitialized();

    const nameEncoded = encodeName(params.name);
    const spotMarketIndex = params.spotMarketIndex ?? 0; // USDC
    const redeemPeriod = new BN(params.redeemPeriod ?? 604800); // 7 days
    const maxTokens = new BN(params.maxTokens ?? 0); // 0 = unlimited
    const minDepositAmount = new BN(params.minDepositAmount ?? 0);
    const managementFee = new BN(params.managementFee ?? 200); // 200 bps = 2%
    const profitShare = params.profitShare ?? 2000; // 20%
    const permissioned = params.permissioned ?? false;

    logger.info("Initializing vault", {
      name: params.name,
      spotMarketIndex,
      redeemPeriod: redeemPeriod.toString(),
      maxTokens: maxTokens.toString(),
      managementFee: managementFee.toString(),
      profitShare,
      permissioned,
    });

    const txSig = await this.vaultClient.initializeVault({
      name: nameEncoded,
      spotMarketIndex,
      redeemPeriod,
      maxTokens,
      minDepositAmount,
      managementFee,
      profitShare,
      hurdleRate: 0,
      permissioned,
    });

    const vaultAddress = getVaultAddressSync(VAULT_PROGRAM_ID, nameEncoded);

    logger.info("Vault initialized", {
      vault: vaultAddress.toBase58(),
      txSig,
    });

    return { vaultAddress, txSig };
  }

  /**
   * Set the delegate address for a vault (delegate can trade on vault's behalf).
   */
  async updateDelegate(
    vaultAddress: PublicKey,
    delegateAddress: PublicKey
  ): Promise<string> {
    this.ensureInitialized();

    logger.info("Updating vault delegate", {
      vault: vaultAddress.toBase58(),
      delegate: delegateAddress.toBase58(),
    });

    const txSig = await this.vaultClient.updateDelegate(
      vaultAddress,
      delegateAddress
    );

    logger.info("Vault delegate updated", { txSig });
    return txSig;
  }

  /**
   * Enable margin trading on the vault's Drift user account.
   */
  async enableMarginTrading(vaultAddress: PublicKey): Promise<string> {
    this.ensureInitialized();

    logger.info("Enabling margin trading for vault", {
      vault: vaultAddress.toBase58(),
    });

    const txSig = await this.vaultClient.updateMarginTradingEnabled(
      vaultAddress,
      true
    );

    logger.info("Margin trading enabled", { txSig });
    return txSig;
  }

  /**
   * Update vault parameters (redeem period, max tokens, fees, etc.).
   */
  async updateVault(
    vaultAddress: PublicKey,
    params: UpdateVaultParams
  ): Promise<string> {
    this.ensureInitialized();

    logger.info("Updating vault parameters", {
      vault: vaultAddress.toBase58(),
      params: {
        redeemPeriod: params.redeemPeriod?.toString() ?? null,
        maxTokens: params.maxTokens?.toString() ?? null,
        managementFee: params.managementFee?.toString() ?? null,
        minDepositAmount: params.minDepositAmount?.toString() ?? null,
        profitShare: params.profitShare ?? null,
        hurdleRate: params.hurdleRate ?? null,
        permissioned: params.permissioned ?? null,
      },
    });

    const txSig = await this.vaultClient.managerUpdateVault(
      vaultAddress,
      params
    );

    logger.info("Vault updated", { txSig });
    return txSig;
  }

  // ── Manager Deposits & Withdrawals ──────────────────────────────────

  /**
   * Manager deposits USDC into the vault.
   * @param amount USDC amount as Decimal (e.g., new Decimal("100.50"))
   */
  async managerDeposit(
    vaultAddress: PublicKey,
    amount: Decimal
  ): Promise<string> {
    this.ensureInitialized();

    const amountBN = this.usdcToBN(amount);

    logger.info("Manager depositing to vault", {
      vault: vaultAddress.toBase58(),
      amount: amount.toFixed(6),
      amountRaw: amountBN.toString(),
    });

    const txSig = await this.vaultClient.managerDeposit(
      vaultAddress,
      amountBN
    );

    logger.info("Manager deposit completed", { txSig });
    return txSig;
  }

  /**
   * Manager requests a withdrawal from the vault (in token units).
   * @param amount USDC amount as Decimal
   */
  async managerRequestWithdraw(
    vaultAddress: PublicKey,
    amount: Decimal
  ): Promise<string> {
    this.ensureInitialized();

    const amountBN = this.usdcToBN(amount);

    logger.info("Manager requesting withdrawal", {
      vault: vaultAddress.toBase58(),
      amount: amount.toFixed(6),
    });

    const txSig = await this.vaultClient.managerRequestWithdraw(
      vaultAddress,
      amountBN,
      WithdrawUnit.TOKEN
    );

    logger.info("Manager withdraw request submitted", { txSig });
    return txSig;
  }

  /**
   * Manager completes a pending withdrawal after redeem period has elapsed.
   */
  async managerWithdraw(vaultAddress: PublicKey): Promise<string> {
    this.ensureInitialized();

    logger.info("Manager completing withdrawal", {
      vault: vaultAddress.toBase58(),
    });

    const txSig = await this.vaultClient.managerWithdraw(vaultAddress);

    logger.info("Manager withdrawal completed", { txSig });
    return txSig;
  }

  /**
   * Manager cancels a pending withdrawal request.
   */
  async managerCancelWithdrawRequest(
    vaultAddress: PublicKey
  ): Promise<string> {
    this.ensureInitialized();

    logger.info("Manager cancelling withdraw request", {
      vault: vaultAddress.toBase58(),
    });

    const txSig =
      await this.vaultClient.managerCancelWithdrawRequest(vaultAddress);

    logger.info("Manager withdraw request cancelled", { txSig });
    return txSig;
  }

  // ── Depositor Operations ────────────────────────────────────────────

  /**
   * Initialize a vault depositor account.
   * @param authority Optional authority for the depositor (defaults to wallet pubkey).
   */
  async initializeDepositor(
    vaultAddress: PublicKey,
    authority?: PublicKey
  ): Promise<string> {
    this.ensureInitialized();

    const depositorAuthority = authority ?? this.wallet.publicKey;

    logger.info("Initializing vault depositor", {
      vault: vaultAddress.toBase58(),
      authority: depositorAuthority.toBase58(),
    });

    const txSig = await this.vaultClient.initializeVaultDepositor(
      vaultAddress,
      depositorAuthority
    );

    const depositorAddress = getVaultDepositorAddressSync(
      VAULT_PROGRAM_ID,
      vaultAddress,
      depositorAuthority
    );

    logger.info("Vault depositor initialized", {
      depositor: depositorAddress.toBase58(),
      txSig,
    });

    return txSig;
  }

  /**
   * Deposit USDC into a vault as a depositor.
   * @param vaultDepositorAddress The vault depositor PDA address.
   * @param amount USDC amount as Decimal.
   */
  async deposit(
    vaultDepositorAddress: PublicKey,
    amount: Decimal
  ): Promise<string> {
    this.ensureInitialized();

    const amountBN = this.usdcToBN(amount);

    logger.info("Depositing to vault", {
      depositor: vaultDepositorAddress.toBase58(),
      amount: amount.toFixed(6),
      amountRaw: amountBN.toString(),
    });

    const txSig = await this.vaultClient.deposit(
      vaultDepositorAddress,
      amountBN
    );

    logger.info("Deposit completed", { txSig });
    return txSig;
  }

  /**
   * Request withdrawal from a vault as a depositor (in token units).
   * @param vaultDepositorAddress The vault depositor PDA address.
   * @param amount USDC amount as Decimal.
   */
  async requestWithdraw(
    vaultDepositorAddress: PublicKey,
    amount: Decimal
  ): Promise<string> {
    this.ensureInitialized();

    const amountBN = this.usdcToBN(amount);

    logger.info("Requesting withdrawal from vault", {
      depositor: vaultDepositorAddress.toBase58(),
      amount: amount.toFixed(6),
    });

    const txSig = await this.vaultClient.requestWithdraw(
      vaultDepositorAddress,
      amountBN,
      WithdrawUnit.TOKEN
    );

    logger.info("Withdraw request submitted", { txSig });
    return txSig;
  }

  /**
   * Complete a pending depositor withdrawal after redeem period has elapsed.
   */
  async withdraw(vaultDepositorAddress: PublicKey): Promise<string> {
    this.ensureInitialized();

    logger.info("Completing depositor withdrawal", {
      depositor: vaultDepositorAddress.toBase58(),
    });

    const txSig = await this.vaultClient.withdraw(vaultDepositorAddress);

    logger.info("Depositor withdrawal completed", { txSig });
    return txSig;
  }

  // ── View Methods ────────────────────────────────────────────────────

  /**
   * Fetch vault account data and return a structured VaultInfo.
   */
  async getVault(vaultAddress: PublicKey): Promise<VaultInfo> {
    this.ensureInitialized();

    const vault: Vault = await this.vaultClient.getVault(vaultAddress);

    return {
      address: vaultAddress,
      name: decodeName(vault.name),
      manager: vault.manager,
      delegate: vault.delegate,
      user: vault.user,
      spotMarketIndex: vault.spotMarketIndex,
      userShares: vault.userShares,
      totalShares: vault.totalShares,
      redeemPeriod: vault.redeemPeriod.toNumber(),
      maxTokens: vault.maxTokens,
      minDepositAmount: vault.minDepositAmount,
      managementFee: vault.managementFee,
      profitShare: vault.profitShare,
      hurdleRate: vault.hurdleRate,
      permissioned: vault.permissioned,
      netDeposits: vault.netDeposits,
      totalDeposits: vault.totalDeposits,
      totalWithdraws: vault.totalWithdraws,
      totalWithdrawRequested: vault.totalWithdrawRequested,
      managerTotalDeposits: vault.managerTotalDeposits,
      managerTotalWithdraws: vault.managerTotalWithdraws,
      managerTotalFee: vault.managerTotalFee,
      managerTotalProfitShare: vault.managerTotalProfitShare,
      lastManagerWithdrawRequest: vault.lastManagerWithdrawRequest,
      initTs: vault.initTs,
    };
  }

  /**
   * Calculate the total vault equity in USDC.
   */
  async getVaultEquity(vaultAddress: PublicKey): Promise<Decimal> {
    this.ensureInitialized();

    const equityBN = await this.vaultClient.calculateVaultEquity({
      address: vaultAddress,
      factorUnrealizedPNL: true,
    });

    return this.bnToUsdc(equityBN);
  }

  /**
   * Fetch all depositors for a given vault.
   */
  async getDepositors(vaultAddress: PublicKey): Promise<DepositorInfo[]> {
    this.ensureInitialized();

    const depositorAccounts =
      await this.vaultClient.getAllVaultDepositors(vaultAddress);

    return depositorAccounts.map((pa: any) => {
      const d = pa.account as VaultDepositor;
      return {
        address: pa.publicKey,
        vault: d.vault,
        authority: d.authority,
        vaultShares: d.vaultShares,
        netDeposits: d.netDeposits,
        totalDeposits: d.totalDeposits,
        totalWithdraws: d.totalWithdraws,
        lastWithdrawRequest: d.lastWithdrawRequest,
      };
    });
  }

  // ── Profit Share & Monitoring ──────────────────────────────────────

  /**
   * Apply profit share fees across all depositors.
   * Should be called periodically to realize management + performance fees.
   */
  async applyProfitShareToAll(vaultAddress: PublicKey): Promise<void> {
    this.ensureInitialized();

    const depositors = await this.vaultClient.getAllVaultDepositors(vaultAddress);

    let applied = 0;
    let skipped = 0;
    for (const pa of depositors) {
      try {
        const ix = await (this.vaultClient as any).getApplyProfitShareIx(
          vaultAddress,
          pa.publicKey
        );
        await (this.vaultClient as any).createAndSendTxn([ix]);
        applied++;
      } catch (err) {
        // Skip depositors with no profit to share or other non-critical failures
        skipped++;
        logger.info(`Profit share skipped for depositor ${pa.publicKey.toBase58()}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info(`Applied profit share to ${applied}/${depositors.length} depositors (${skipped} skipped)`);
  }

  /**
   * Check if outstanding withdrawals could trigger a liquidation takeover.
   * Returns true if the vault is at risk (totalWithdrawRequested is large
   * relative to vault equity and could breach margin on redemption).
   *
   * Docs: "Monitor total outstanding withdrawal requests and keep margin usage
   * in check so depositor withdrawals don't trigger takeovers."
   */
  async checkWithdrawalRisk(
    vaultAddress: PublicKey,
    marginThreshold: number = 0.5
  ): Promise<{
    atRisk: boolean;
    totalWithdrawRequested: Decimal;
    vaultEquity: Decimal;
    withdrawRatio: Decimal;
  }> {
    this.ensureInitialized();

    const vault = await this.vaultClient.getVault(vaultAddress);
    const equity = await this.getVaultEquity(vaultAddress);
    const withdrawRequested = this.bnToUsdc(vault.totalWithdrawRequested);

    const withdrawRatio = equity.gt(0)
      ? withdrawRequested.div(equity)
      : new Decimal(0);

    const atRisk = withdrawRatio.gt(marginThreshold);

    if (atRisk) {
      logger.warn("VAULT AT RISK: Large outstanding withdrawal requests", {
        vault: vaultAddress.toBase58(),
        withdrawRequested: `$${withdrawRequested.toFixed(2)}`,
        equity: `$${equity.toFixed(2)}`,
        ratio: `${withdrawRatio.mul(100).toFixed(1)}%`,
      });
    }

    return { atRisk, totalWithdrawRequested: withdrawRequested, vaultEquity: equity, withdrawRatio };
  }

  /**
   * Get the vault's Drift user account public key.
   * Use this as the `authority` when creating a DriftClient for delegated trading.
   *
   * Docs: "Each vault has its own Drift user account that the manager trades with.
   * The manager has delegate authority over this account."
   */
  async getVaultDriftUserAccount(vaultAddress: PublicKey): Promise<PublicKey> {
    this.ensureInitialized();
    const vault = await this.vaultClient.getVault(vaultAddress);
    return vault.user;
  }

  /**
   * Get the DriftClient config needed to trade as the vault's delegate.
   * Pass these values when constructing a DriftManager with delegateFor.
   */
  async getDelegateConfig(
    vaultAddress: PublicKey,
    subAccountId: number = 0
  ): Promise<{
    authority: PublicKey;
    subAccountIds: number[];
    activeSubAccountId: number;
  }> {
    this.ensureInitialized();
    const vault = await this.vaultClient.getVault(vaultAddress);

    // The vault PDA owns the vault's Drift user account.
    // When trading as delegate, set authority = vault PDA.
    return {
      authority: vaultAddress,
      subAccountIds: [subAccountId],
      activeSubAccountId: subAccountId,
    };
  }

  // ── Address Helpers ─────────────────────────────────────────────────

  /**
   * Derive the vault PDA address from a vault name.
   */
  getVaultAddress(name: string): PublicKey {
    return getVaultAddressSync(VAULT_PROGRAM_ID, encodeName(name));
  }

  /**
   * Derive the vault depositor PDA address from a vault address and authority.
   */
  getDepositorAddress(
    vaultAddress: PublicKey,
    authority: PublicKey
  ): PublicKey {
    return getVaultDepositorAddressSync(
      VAULT_PROGRAM_ID,
      vaultAddress,
      authority
    );
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  /**
   * Unsubscribe from vault user map and clean up resources.
   */
  async shutdown(): Promise<void> {
    if (this.initialized && this.vaultClient) {
      await this.vaultClient.unsubscribe();
      this.initialized = false;
      logger.info("DriftVaultManager shut down");
    }
  }

  // ── Internal Helpers ────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "DriftVaultManager not initialized. Call initialize() first."
      );
    }
  }

  /**
   * Convert a Decimal USDC amount to BN with 1e6 precision.
   */
  private usdcToBN(amount: Decimal): BN {
    return new BN(amount.mul(USDC_PRECISION.toNumber()).toFixed(0));
  }

  /**
   * Convert a BN USDC amount (1e6 precision) to Decimal.
   */
  private bnToUsdc(amount: BN): Decimal {
    return new Decimal(amount.toString()).div(USDC_PRECISION.toNumber());
  }

  // ── Manager Borrow / Repay (from drift-vaults SDK vaultClient.ts) ──

  /**
   * Manager borrows against vault collateral.
   * From: drift-vaults/ts/sdk/src/vaultClient.ts → managerBorrow()
   *
   * This allows leveraged strategies — borrow SOL against USDC
   * collateral to short-sell, or borrow USDC to increase position sizes.
   */
  async managerBorrow(
    vaultAddress: PublicKey,
    amount: Decimal,
    spotMarketIndex: number = 0
  ): Promise<string> {
    const amountBN = this.usdcToBN(amount);

    const txSig = await (this.vaultClient as any).managerBorrow(
      vaultAddress,
      amountBN,
      spotMarketIndex
    );

    logger.info("Vault: manager borrowed", {
      vault: vaultAddress.toBase58().slice(0, 8),
      amount: amount.toFixed(2),
      spotMarketIndex,
      txSig,
    });

    return typeof txSig === "string" ? txSig : "";
  }

  /**
   * Manager repays borrowed amount.
   * From: drift-vaults/ts/sdk/src/vaultClient.ts → managerRepay()
   */
  async managerRepay(
    vaultAddress: PublicKey,
    amount: Decimal,
    spotMarketIndex: number = 0
  ): Promise<string> {
    const amountBN = this.usdcToBN(amount);

    const txSig = await (this.vaultClient as any).managerRepay(
      vaultAddress,
      amountBN,
      spotMarketIndex
    );

    logger.info("Vault: manager repaid", {
      vault: vaultAddress.toBase58().slice(0, 8),
      amount: amount.toFixed(2),
      spotMarketIndex,
      txSig,
    });

    return typeof txSig === "string" ? txSig : "";
  }

  // ── Force Withdraw (from drift-vaults SDK) ────────────────────

  /**
   * Force-process a depositor's pending withdrawal.
   * From: drift-vaults/ts/sdk/src/vaultClient.ts → forceWithdraw()
   *
   * Needed when depositors request withdrawal but the manager needs
   * to proactively process them (e.g., to prevent liquidation takeover).
   */
  async forceWithdraw(
    vaultAddress: PublicKey,
    vaultDepositorAddress: PublicKey
  ): Promise<string> {
    const txSig = await (this.vaultClient as any).forceWithdraw(
      vaultAddress,
      vaultDepositorAddress
    );

    logger.info("Vault: force withdrawal processed", {
      vault: vaultAddress.toBase58().slice(0, 8),
      depositor: vaultDepositorAddress.toBase58().slice(0, 8),
      txSig,
    });

    return typeof txSig === "string" ? txSig : "";
  }

  // ── Liquidate (from drift-vaults SDK) ─────────────────────────

  /**
   * Liquidate an undercollateralized vault depositor.
   * From: drift-vaults/ts/sdk/src/vaultClient.ts → liquidate()
   */
  async liquidateDepositor(
    vaultAddress: PublicKey,
    vaultDepositorAddress: PublicKey
  ): Promise<string> {
    const txSig = await (this.vaultClient as any).liquidate(
      vaultAddress,
      vaultDepositorAddress
    );

    logger.info("Vault: depositor liquidated", {
      vault: vaultAddress.toBase58().slice(0, 8),
      depositor: vaultDepositorAddress.toBase58().slice(0, 8),
      txSig,
    });

    return typeof txSig === "string" ? txSig : "";
  }

  // ── All-Time PnL (from drift-vaults SDK) ──────────────────────

  /**
   * Calculate vault's all-time notional PnL.
   * From: drift-vaults/ts/sdk/src/vaultClient.ts → calculateVaultAllTimeNotionalPnl()
   */
  async getAllTimePnl(vaultAddress: PublicKey): Promise<Decimal> {
    try {
      const pnl = await (this.vaultClient as any).calculateVaultAllTimeNotionalPnl(
        vaultAddress
      );
      return this.bnToUsdc(pnl);
    } catch {
      return new Decimal(0);
    }
  }

  /**
   * Calculate what a specific depositor can actually withdraw.
   * From: drift-vaults/ts/sdk/src/vaultClient.ts → calculateWithdrawableVaultDepositorEquity()
   */
  async getWithdrawableEquity(
    vaultAddress: PublicKey,
    vaultDepositorAddress: PublicKey
  ): Promise<Decimal> {
    try {
      const equity = await (this.vaultClient as any).calculateWithdrawableVaultDepositorEquity(
        vaultAddress,
        vaultDepositorAddress
      );
      return this.bnToUsdc(equity);
    } catch {
      return new Decimal(0);
    }
  }
}

export { VAULT_PROGRAM_ID, WithdrawUnit, encodeName, decodeName };
export type { Vault, VaultDepositor, UpdateVaultParams };
