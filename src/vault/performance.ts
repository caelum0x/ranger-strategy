/**
 * Vault Performance Tracker — NAV tracking, share price history,
 * depositor attribution, and withdrawal-aware capital management.
 *
 * Thinking as a vault manager:
 * - Track NAV (Net Asset Value) over time for reporting
 * - Calculate share price evolution for depositor P&L
 * - Reserve liquidity for pending withdrawals
 * - Monitor fee income and vault profitability
 * - Provide data for hackathon submission (verifiable vault performance)
 */
import Decimal from "decimal.js";
import fs from "fs";
import path from "path";
import { StrategyState } from "../strategy/types";
import { logger } from "../utils/logger";

// ── Types ──────────────────────────────────────────────────────────────

export interface NAVSnapshot {
  timestamp: number;
  /** Total vault equity in USDC */
  nav: string;
  /** Share price (NAV / total shares) */
  sharePrice: string;
  /** Capital deployed in positions */
  deployed: string;
  /** Idle capital (available for withdrawals) */
  idle: string;
  /** Cumulative funding income */
  fundingIncome: string;
  /** Cumulative trading costs */
  tradingCosts: string;
  /** Pending withdrawal amount */
  pendingWithdrawals: string;
  /** Health ratio at snapshot time */
  healthRatio: string;
  /** Strategy cycle number */
  cycle: number;
}

export interface DepositorEquity {
  authority: string;
  shares: string;
  shareOfVault: string;
  estimatedEquity: string;
  netDeposits: string;
  estimatedPnl: string;
}

export interface VaultPerformanceReport {
  /** Vault creation timestamp */
  inception: number | null;
  /** Current NAV */
  currentNAV: Decimal;
  /** Current share price */
  sharePrice: Decimal;
  /** NAV at inception (first snapshot) */
  inceptionNAV: Decimal;
  /** Total return since inception */
  totalReturn: Decimal;
  /** Annualized return since inception */
  annualizedReturn: Decimal;
  /** Maximum drawdown from peak NAV */
  maxDrawdown: Decimal;
  /** Sharpe ratio estimate */
  sharpeEstimate: Decimal;
  /** Total fees earned by manager */
  totalFeesEarned: Decimal;
  /** Number of depositors */
  depositorCount: number;
  /** Pending withdrawals as % of NAV */
  withdrawalPressure: Decimal;
  /** Available liquidity for redemptions */
  availableLiquidity: Decimal;
  /** Capital utilization (deployed / NAV) */
  capitalUtilization: Decimal;
}

// ── Constants ──────────────────────────────────────────────────────────

const PERF_DIR = path.join(process.cwd(), ".ranger-state");
const NAV_FILE = path.join(PERF_DIR, "nav-history.jsonl");
const MAX_NAV_FILE_BYTES = 5 * 1024 * 1024; // 5MB

// ── Performance Tracker ────────────────────────────────────────────────

export class VaultPerformanceTracker {
  private totalShares: Decimal = new Decimal(0);
  private pendingWithdrawals: Decimal = new Decimal(0);
  private depositorCount: number = 0;
  private managerFeesEarned: Decimal = new Decimal(0);
  private inceptionTime: number | null = null;

  /**
   * Record a NAV snapshot. Call this at the end of each strategy cycle.
   */
  recordSnapshot(state: StrategyState, extraData?: {
    pendingWithdrawals?: Decimal;
    totalShares?: Decimal;
    depositorCount?: number;
    managerFees?: Decimal;
  }): void {
    if (extraData?.pendingWithdrawals) this.pendingWithdrawals = extraData.pendingWithdrawals;
    if (extraData?.totalShares) this.totalShares = extraData.totalShares;
    if (extraData?.depositorCount !== undefined) this.depositorCount = extraData.depositorCount;
    if (extraData?.managerFees) this.managerFeesEarned = extraData.managerFees;

    const nav = state.totalCapital.add(state.totalPnl);
    const sharePrice = this.totalShares.gt(0) ? nav.div(this.totalShares) : new Decimal(1);

    const snapshot: NAVSnapshot = {
      timestamp: Date.now(),
      nav: nav.toFixed(6),
      sharePrice: sharePrice.toFixed(8),
      deployed: state.deployedCapital.toFixed(6),
      idle: state.idleCapital.toFixed(6),
      fundingIncome: state.totalFundingCollected.toFixed(6),
      tradingCosts: state.totalTradingCosts.toFixed(6),
      pendingWithdrawals: this.pendingWithdrawals.toFixed(6),
      healthRatio: state.healthRatio.toFixed(4),
      cycle: state.cycleCount,
    };

    this.writeSnapshot(snapshot);
  }

  /**
   * Calculate how much capital must be reserved for pending withdrawals.
   *
   * As vault manager, we must ensure enough idle USDC to honor redemptions.
   * If withdrawals > idle capital, positions need to be reduced.
   *
   * Returns the maximum capital that can be deployed in new positions.
   */
  getDeployableCapital(
    totalCapital: Decimal,
    idleCapital: Decimal,
    pendingWithdrawals: Decimal,
    /** Safety buffer — keep extra % idle beyond pending withdrawals */
    liquidityBuffer: Decimal = new Decimal("0.10")
  ): { deployable: Decimal; reserved: Decimal; needsReduction: boolean } {
    // Reserve pending withdrawals + buffer
    const bufferAmount = totalCapital.mul(liquidityBuffer);
    const reserved = Decimal.max(pendingWithdrawals, bufferAmount);

    // Deployable = idle - reserved (can't be negative)
    const deployable = Decimal.max(new Decimal(0), idleCapital.sub(reserved));

    // If pending withdrawals exceed idle capital, we need to unwind positions
    const needsReduction = pendingWithdrawals.gt(idleCapital);

    if (needsReduction) {
      logger.warn("Pending withdrawals exceed idle capital — position reduction needed", {
        pendingWithdrawals: pendingWithdrawals.toFixed(2),
        idleCapital: idleCapital.toFixed(2),
        shortfall: pendingWithdrawals.sub(idleCapital).toFixed(2),
      });
    }

    return { deployable, reserved, needsReduction };
  }

  /**
   * Generate vault performance report from historical NAV data.
   */
  generateReport(): VaultPerformanceReport {
    const snapshots = this.readSnapshots();

    const defaultReport: VaultPerformanceReport = {
      inception: this.inceptionTime,
      currentNAV: new Decimal(0),
      sharePrice: new Decimal(1),
      inceptionNAV: new Decimal(0),
      totalReturn: new Decimal(0),
      annualizedReturn: new Decimal(0),
      maxDrawdown: new Decimal(0),
      sharpeEstimate: new Decimal(0),
      totalFeesEarned: this.managerFeesEarned,
      depositorCount: this.depositorCount,
      withdrawalPressure: new Decimal(0),
      availableLiquidity: new Decimal(0),
      capitalUtilization: new Decimal(0),
    };

    if (snapshots.length === 0) return defaultReport;

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    const currentNAV = new Decimal(last.nav);
    const inceptionNAV = new Decimal(first.nav);
    const sharePrice = new Decimal(last.sharePrice);
    const idle = new Decimal(last.idle);
    const deployed = new Decimal(last.deployed);
    const pending = new Decimal(last.pendingWithdrawals);

    // Total return
    const totalReturn = inceptionNAV.gt(0)
      ? currentNAV.sub(inceptionNAV).div(inceptionNAV).mul(100)
      : new Decimal(0);

    // Annualized return
    const elapsedMs = last.timestamp - first.timestamp;
    const elapsedDays = elapsedMs / (86400 * 1000);
    const annualizedReturn = elapsedDays > (1 / 24)
      ? totalReturn.div(elapsedDays).mul(365.25)
      : new Decimal(0);

    // Max drawdown from NAV history
    let peakNAV = new Decimal(0);
    let maxDrawdown = new Decimal(0);
    for (const snap of snapshots) {
      const nav = new Decimal(snap.nav);
      if (nav.gt(peakNAV)) peakNAV = nav;
      const dd = peakNAV.gt(0) ? peakNAV.sub(nav).div(peakNAV).mul(100) : new Decimal(0);
      if (dd.gt(maxDrawdown)) maxDrawdown = dd;
    }

    // Sharpe estimate (annualized return / max drawdown)
    const sharpeEstimate = maxDrawdown.gt(0)
      ? annualizedReturn.div(maxDrawdown)
      : annualizedReturn;

    // Withdrawal pressure
    const withdrawalPressure = currentNAV.gt(0)
      ? pending.div(currentNAV).mul(100)
      : new Decimal(0);

    // Capital utilization
    const capitalUtilization = currentNAV.gt(0)
      ? deployed.div(currentNAV).mul(100)
      : new Decimal(0);

    return {
      inception: first.timestamp,
      currentNAV,
      sharePrice,
      inceptionNAV,
      totalReturn,
      annualizedReturn,
      maxDrawdown,
      sharpeEstimate,
      totalFeesEarned: this.managerFeesEarned,
      depositorCount: this.depositorCount,
      withdrawalPressure,
      availableLiquidity: idle,
      capitalUtilization,
    };
  }

  /**
   * Calculate per-depositor equity breakdown.
   * Each depositor's equity = (their shares / total shares) * NAV
   */
  calculateDepositorEquity(
    depositors: Array<{
      authority: string;
      shares: Decimal;
      netDeposits: Decimal;
    }>,
    nav: Decimal
  ): DepositorEquity[] {
    if (depositors.length === 0) return [];

    const totalShares = depositors.reduce(
      (sum, d) => sum.add(d.shares),
      new Decimal(0)
    );

    return depositors.map((d) => {
      const shareOfVault = totalShares.gt(0)
        ? d.shares.div(totalShares)
        : new Decimal(0);
      const estimatedEquity = nav.mul(shareOfVault);
      const estimatedPnl = estimatedEquity.sub(d.netDeposits);

      return {
        authority: d.authority,
        shares: d.shares.toFixed(6),
        shareOfVault: `${shareOfVault.mul(100).toFixed(2)}%`,
        estimatedEquity: estimatedEquity.toFixed(4),
        netDeposits: d.netDeposits.toFixed(4),
        estimatedPnl: estimatedPnl.toFixed(4),
      };
    });
  }

  /**
   * Get NAV history for charting/export.
   */
  getNAVHistory(limit?: number): NAVSnapshot[] {
    const all = this.readSnapshots();
    return limit ? all.slice(-limit) : all;
  }

  /**
   * Format report for console/dashboard display.
   */
  formatReport(report: VaultPerformanceReport): Record<string, string> {
    return {
      currentNAV: `$${report.currentNAV.toFixed(2)}`,
      sharePrice: report.sharePrice.toFixed(6),
      totalReturn: `${report.totalReturn.toFixed(2)}%`,
      annualizedReturn: `${report.annualizedReturn.toFixed(2)}%`,
      maxDrawdown: `${report.maxDrawdown.toFixed(2)}%`,
      sharpeEstimate: report.sharpeEstimate.toFixed(2),
      depositorCount: report.depositorCount.toString(),
      withdrawalPressure: `${report.withdrawalPressure.toFixed(1)}%`,
      availableLiquidity: `$${report.availableLiquidity.toFixed(2)}`,
      capitalUtilization: `${report.capitalUtilization.toFixed(1)}%`,
      totalFeesEarned: `$${report.totalFeesEarned.toFixed(4)}`,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private writeSnapshot(snapshot: NAVSnapshot): void {
    try {
      if (!fs.existsSync(PERF_DIR)) {
        fs.mkdirSync(PERF_DIR, { recursive: true });
      }

      // Rotate if too large
      if (fs.existsSync(NAV_FILE)) {
        const stats = fs.statSync(NAV_FILE);
        if (stats.size > MAX_NAV_FILE_BYTES) {
          const rotated = NAV_FILE + ".1";
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(NAV_FILE, rotated);
        }
      }

      fs.appendFileSync(NAV_FILE, JSON.stringify(snapshot) + "\n");
    } catch (err) {
      logger.warn("Failed to write NAV snapshot", { error: err });
    }
  }

  private readSnapshots(): NAVSnapshot[] {
    try {
      if (!fs.existsSync(NAV_FILE)) return [];
      const lines = fs.readFileSync(NAV_FILE, "utf-8").trim().split("\n");
      return lines
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as NAVSnapshot);
    } catch {
      return [];
    }
  }
}
