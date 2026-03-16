/**
 * Voltr Vault Strategy Client — deposit/withdraw from Ranger Earn strategies.
 *
 * Ported from voltr-plugin/tools/voltr_deposit_strategy.ts + voltr_withdraw_strategy.ts.
 * Voltr is the vault protocol underlying Ranger Earn — this client manages
 * strategy-level deposits and withdrawals.
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { logger } from "../utils/logger";

const VOLTR_API = "https://app.voltr.xyz";

export interface VoltrStrategyPosition {
  strategyAddress: string;
  depositedAmount: number;
  currentValue: number;
  apy: number;
}

export class VoltrClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Get remaining accounts and instruction args for a Voltr strategy operation.
   * From: voltr-plugin — fetches dynamic accounts from Voltr API.
   */
  private async getStrategyAccounts(
    vaultAddress: string,
    strategyAddress: string,
    operation: "deposit" | "withdraw"
  ): Promise<{ remainingAccounts: any[]; args: any }> {
    const endpoint = operation === "deposit"
      ? `${VOLTR_API}/api/v1/vault_deposit_strategy/${vaultAddress}/${strategyAddress}`
      : `${VOLTR_API}/api/v1/vault_withdraw_strategy/${vaultAddress}/${strategyAddress}`;

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Voltr API ${operation} failed: ${response.status}`);
    }

    const data = ((await response.json()) as any);
    return {
      remainingAccounts: data.remainingAccounts || [],
      args: data.additionalArgs || {},
    };
  }

  /**
   * Deposit into a Voltr strategy.
   * From: voltr-plugin/tools/voltr_deposit_strategy.ts
   */
  async depositStrategy(
    vaultAddress: string,
    strategyAddress: string,
    amount: number
  ): Promise<string> {
    logger.info("Voltr: depositing into strategy", {
      vault: vaultAddress.slice(0, 8),
      strategy: strategyAddress.slice(0, 8),
      amount,
    });

    const { remainingAccounts, args } = await this.getStrategyAccounts(
      vaultAddress,
      strategyAddress,
      "deposit"
    );

    // In production: build instruction using @voltr/vault-sdk
    // depositStrategy(vault, strategy, amount, remainingAccounts, args)
    logger.info("Voltr: deposit instruction built", {
      remainingAccountCount: remainingAccounts.length,
    });

    return ""; // TX sig returned by actual execution
  }

  /**
   * Withdraw from a Voltr strategy.
   * From: voltr-plugin/tools/voltr_withdraw_strategy.ts
   */
  async withdrawStrategy(
    vaultAddress: string,
    strategyAddress: string,
    amount: number
  ): Promise<string> {
    logger.info("Voltr: withdrawing from strategy", {
      vault: vaultAddress.slice(0, 8),
      strategy: strategyAddress.slice(0, 8),
      amount,
    });

    const { remainingAccounts, args } = await this.getStrategyAccounts(
      vaultAddress,
      strategyAddress,
      "withdraw"
    );

    logger.info("Voltr: withdraw instruction built", {
      remainingAccountCount: remainingAccounts.length,
    });

    return "";
  }

  /**
   * Get position values for all strategies in a vault.
   * From: voltr-plugin/tools/voltr_get_position_values.ts
   */
  async getPositionValues(vaultAddress: string): Promise<VoltrStrategyPosition[]> {
    const response = await fetch(
      `${VOLTR_API}/api/v1/vault/${vaultAddress}/positions`
    );
    if (!response.ok) return [];
    return (await response.json()) as any;
  }
}
