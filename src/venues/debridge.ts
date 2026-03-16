/**
 * deBridge cross-chain bridging — move capital between chains.
 *
 * Ported from debridge-plugin/tools/get_bridge_quote.ts + bridge_tokens.ts.
 * Enables cross-chain capital deployment:
 *   - Bridge USDC from Ethereum/Arbitrum to Solana for Drift strategy
 *   - Bridge profits back to other chains
 *   - Cross-chain arb opportunities
 *
 * Used by: capital management, cross-chain yield optimization.
 */
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface BridgeQuote {
  srcChainId: number;
  dstChainId: number;
  srcTokenAddress: string;
  dstTokenAddress: string;
  srcAmount: string;
  dstAmount: string;
  estimatedFee: string;
  executionTime: number; // seconds
  priceImpact: number;
}

export interface BridgeTransaction {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

// ── deBridge Client ─────────────────────────────────────────────

const DEBRIDGE_API = "https://deswap.debridge.finance/v1.0";

export class DeBridgeClient {
  /**
   * Get a cross-chain bridge quote.
   * From: debridge-plugin/tools/get_bridge_quote.ts → getBridgeQuote()
   */
  async getQuote(params: {
    srcChainId: number;     // e.g., 1 = Ethereum, 42161 = Arbitrum
    dstChainId: number;     // 7565164 = Solana
    srcTokenAddress: string;
    dstTokenAddress: string;
    amount: string;         // in smallest units
    slippage?: number;      // percentage, default 1
  }): Promise<BridgeQuote | null> {
    try {
      const queryParams = new URLSearchParams({
        srcChainId: params.srcChainId.toString(),
        srcChainTokenIn: params.srcTokenAddress,
        srcChainTokenInAmount: params.amount,
        dstChainId: params.dstChainId.toString(),
        dstChainTokenOut: params.dstTokenAddress,
        slippage: (params.slippage || 1).toString(),
        prependOperatingExpenses: "true",
      });

      const response = await fetch(
        `${DEBRIDGE_API}/estimation?${queryParams.toString()}`
      );
      if (!response.ok) return null;

      const data = ((await response.json()) as any);
      return {
        srcChainId: params.srcChainId,
        dstChainId: params.dstChainId,
        srcTokenAddress: params.srcTokenAddress,
        dstTokenAddress: params.dstTokenAddress,
        srcAmount: params.amount,
        dstAmount: data.estimation?.dstChainTokenOut?.amount || "0",
        estimatedFee: data.estimation?.costsDetails?.totalFee || "0",
        executionTime: data.estimation?.executionTime || 0,
        priceImpact: data.estimation?.priceImpact || 0,
      };
    } catch (err) {
      logger.warn("deBridge quote failed", { error: String(err) });
      return null;
    }
  }

  /**
   * Build bridge transaction data.
   * From: debridge-plugin/tools/bridge_tokens.ts
   */
  async buildBridgeTransaction(params: {
    srcChainId: number;
    dstChainId: number;
    srcTokenAddress: string;
    dstTokenAddress: string;
    amount: string;
    dstChainTokenOutRecipient: string;
    senderAddress: string;
    slippage?: number;
  }): Promise<BridgeTransaction | null> {
    try {
      const queryParams = new URLSearchParams({
        srcChainId: params.srcChainId.toString(),
        srcChainTokenIn: params.srcTokenAddress,
        srcChainTokenInAmount: params.amount,
        dstChainId: params.dstChainId.toString(),
        dstChainTokenOut: params.dstTokenAddress,
        dstChainTokenOutRecipient: params.dstChainTokenOutRecipient,
        senderAddress: params.senderAddress,
        slippage: (params.slippage || 1).toString(),
        prependOperatingExpenses: "true",
      });

      const response = await fetch(
        `${DEBRIDGE_API}/transaction?${queryParams.toString()}`
      );
      if (!response.ok) return null;

      const data = ((await response.json()) as any);
      return {
        to: data.tx?.to || "",
        data: data.tx?.data || "",
        value: data.tx?.value || "0",
        chainId: params.srcChainId,
      };
    } catch (err) {
      logger.warn("deBridge build tx failed", { error: String(err) });
      return null;
    }
  }
}

// ── Chain IDs ───────────────────────────────────────────────────

export const CHAIN_IDS = {
  ETHEREUM: 1,
  ARBITRUM: 42161,
  POLYGON: 137,
  BSC: 56,
  AVALANCHE: 43114,
  SOLANA: 7565164,
} as const;
