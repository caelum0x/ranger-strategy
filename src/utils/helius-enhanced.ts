/**
 * Enhanced Helius integration — DAS API, parsed transactions, webhooks.
 *
 * Ported from helius-plugin/tools/*.ts.
 * Goes beyond basic priority fees to use Helius's full API:
 *   - DAS (Digital Asset Standard): NFT/token metadata
 *   - Parsed transaction history
 *   - Priority fee estimation with smart defaults
 *   - Webhook management for vault monitoring
 *
 * Used by: executor (priority fees), indexer (webhooks), monitoring (tx history).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "./logger";

// ── Types ───────────────────────────────────────────────────────

export interface HeliusParsedTransaction {
  signature: string;
  timestamp: number;
  type: string;
  description: string;
  fee: number;
  feePayer: string;
  slot: number;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
  }>;
}

export interface HeliusAsset {
  id: string;
  content: {
    metadata: {
      name: string;
      symbol: string;
    };
  };
  token_info?: {
    balance: number;
    decimals: number;
    price_info?: {
      price_per_token: number;
      total_price: number;
    };
  };
}

export interface WebhookConfig {
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: "enhanced" | "raw";
}

// ── Helius Enhanced Client ──────────────────────────────────────

export class HeliusClient {
  private apiKey: string;
  private rpcUrl: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || config.heliusRpcUrl?.split("/v0/")[1] || process.env.HELIUS_API_KEY || "";
    this.rpcUrl = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
  }

  /**
   * Get parsed transaction history for an address.
   * From: helius-plugin — uses Helius enhanced transaction API.
   */
  async getParsedTransactions(
    address: string,
    limit = 20
  ): Promise<HeliusParsedTransaction[]> {
    try {
      const response = await fetch(
        `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${this.apiKey}&limit=${limit}`
      );
      if (!response.ok) return [];
      return response.json() as any;
    } catch {
      return [];
    }
  }

  /**
   * Get token balances with USD pricing via DAS API.
   * From: helius-plugin — Digital Asset Standard.
   */
  async getTokenBalances(ownerAddress: string): Promise<HeliusAsset[]> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "helius-das",
          method: "searchAssets",
          params: {
            ownerAddress,
            tokenType: "fungible",
            displayOptions: {
              showNativeBalance: true,
            },
          },
        }),
      });

      if (!response.ok) return [];
      const data = (await response.json()) as any;
      return data.result?.items || [];
    } catch {
      return [];
    }
  }

  /**
   * Get smart priority fee estimate.
   * From: helius-plugin/tools/send_transaction_with_priority.ts
   *
   * Uses Helius's getPriorityFeeEstimate for better fee accuracy
   * than generic estimators.
   */
  async getPriorityFeeEstimate(
    accountKeys: string[],
    priorityLevel: "Min" | "Low" | "Medium" | "High" | "VeryHigh" | "UnsafeMax" = "High"
  ): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "helius-fee",
          method: "getPriorityFeeEstimate",
          params: [
            {
              accountKeys,
              options: { priorityLevel },
            },
          ],
        }),
      });

      if (!response.ok) return 50_000; // fallback
      const data = (await response.json()) as any;
      return data.result?.priorityFeeEstimate || 50_000;
    } catch {
      return 50_000;
    }
  }

  /**
   * Create a webhook for monitoring vault/strategy accounts.
   * From: helius-plugin — webhook management.
   */
  async createWebhook(webhookConfig: WebhookConfig): Promise<string | null> {
    try {
      const response = await fetch(
        `https://api.helius.xyz/v0/webhooks?api-key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(webhookConfig),
        }
      );

      if (!response.ok) return null;
      const data = (await response.json()) as any;
      return data.webhookID || null;
    } catch {
      return null;
    }
  }

  /**
   * Delete a webhook.
   */
  async deleteWebhook(webhookId: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${this.apiKey}`,
        { method: "DELETE" }
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
