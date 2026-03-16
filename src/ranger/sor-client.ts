import {
  Connection,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface SorPosition {
  id: string;
  symbol: string;
  side: "Long" | "Short";
  quantity: number;
  entry_price: number;
  unrealized_pnl: number;
  funding_fee: number;
  platform: string;
  created_at: string;
}

interface PositionsResponse {
  positions: SorPosition[];
}

export interface SorQuoteVenue {
  venue_name: string;
  collateral: number;
  size: number;
  quote: {
    base: number;
    fee: number;
    total: number;
  };
  order_available_liquidity: number;
  venue_available_liquidity: number;
}

export interface SorOrderMetadataResponse {
  venues: SorQuoteVenue[];
  total_collateral: number;
  total_size: number;
}

export interface SorTransactionResponse {
  message: string; // base64-encoded versioned transaction
}

export interface IncreasePositionRequest {
  fee_payer: string;
  symbol: string;
  side: "Long" | "Short";
  size: number;
  collateral: number;
  size_denomination: string;
  collateral_denomination: string;
  adjustment_type: "Increase";
}

export interface DecreasePositionRequest {
  fee_payer: string;
  symbol: string;
  side: "Long" | "Short";
  size: number;
  size_denomination: string;
  adjustment_type: "DecreaseDrift" | "DecreaseFlash" | "DecreaseJupiter";
}

export interface ClosePositionRequest {
  fee_payer: string;
  symbol: string;
  side: "Long" | "Short";
  adjustment_type: "CloseDrift" | "CloseFlash" | "CloseJupiter";
}

// ── Transaction helpers (from sor-ts-demo) ──────────────────────

function createTransactionFromBase64(
  base64Message: string
): VersionedTransaction {
  const messageBytes = Buffer.from(base64Message, "base64");
  return VersionedTransaction.deserialize(messageBytes);
}

async function updateBlockhash(
  tx: VersionedTransaction,
  connection: Connection
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  if (tx.message) {
    tx.message.recentBlockhash = blockhash;
  }
  return { blockhash, lastValidBlockHeight };
}

// ── Client ──────────────────────────────────────────────────────

export class RangerSorClient {
  private readonly apiKey: string;
  private readonly sorApiBaseUrl: string;
  private readonly dataApiBaseUrl: string;

  constructor() {
    this.apiKey = config.sorApiKey;
    this.sorApiBaseUrl = config.sorApiBaseUrl;
    this.dataApiBaseUrl = config.sorDataApiBaseUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  // ── Helpers ─────────────────────────────────────────────────

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { "x-api-key": this.apiKey };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `SOR API ${response.status}: ${response.statusText} - ${text}`
      );
    }
    return (await response.json()) as T;
  }

  // ── Positions ───────────────────────────────────────────────

  async getPositions(
    publicKey: string,
    options?: {
      platforms?: string[];
      symbols?: string[];
      from?: string;
    }
  ): Promise<SorPosition[]> {
    if (!this.apiKey) return [];

    const params = new URLSearchParams({ public_key: publicKey });
    for (const platform of options?.platforms || []) {
      params.append("platforms", platform);
    }
    for (const symbol of options?.symbols || []) {
      params.append("symbols", symbol);
    }
    if (options?.from) {
      params.set("from", options.from);
    }

    const response = await fetch(
      `${this.dataApiBaseUrl}/positions?${params.toString()}`,
      { headers: this.headers() }
    );

    if (!response.ok) {
      throw new Error(`SOR positions request failed: ${response.status}`);
    }

    const data = (await response.json()) as PositionsResponse;
    return data.positions || [];
  }

  // ── Quotes ──────────────────────────────────────────────────

  async getOrderMetadata(request: {
    fee_payer: string;
    symbol: string;
    side: "Long" | "Short";
    size: number;
    collateral: number;
    size_denomination: string;
    collateral_denomination: string;
    adjustment_type: "Increase" | "Quote";
  }): Promise<SorOrderMetadataResponse | null> {
    if (!this.apiKey) return null;
    return this.post<SorOrderMetadataResponse>(
      `${this.sorApiBaseUrl}/order_metadata`,
      request
    );
  }

  // ── Trading ─────────────────────────────────────────────────

  async increasePosition(
    request: IncreasePositionRequest
  ): Promise<SorTransactionResponse> {
    logger.info("SOR: increase position", {
      symbol: request.symbol,
      side: request.side,
      size: request.size,
    });
    return this.post<SorTransactionResponse>(
      `${this.sorApiBaseUrl}/increase_position`,
      request
    );
  }

  async decreasePosition(
    request: DecreasePositionRequest
  ): Promise<SorTransactionResponse> {
    logger.info("SOR: decrease position", {
      symbol: request.symbol,
      side: request.side,
      size: request.size,
    });
    return this.post<SorTransactionResponse>(
      `${this.sorApiBaseUrl}/decrease_position`,
      request
    );
  }

  async closePosition(
    request: ClosePositionRequest
  ): Promise<SorTransactionResponse> {
    logger.info("SOR: close position", {
      symbol: request.symbol,
      side: request.side,
    });
    return this.post<SorTransactionResponse>(
      `${this.sorApiBaseUrl}/close_position`,
      request
    );
  }

  // ── Transaction Execution ───────────────────────────────────

  /**
   * Decode a SOR API transaction response into a signable VersionedTransaction,
   * update its blockhash, sign it, and send it to the network.
   */
  async executeTransaction(
    txResponse: SorTransactionResponse,
    connection: Connection,
    signTransaction: (
      tx: VersionedTransaction
    ) => Promise<VersionedTransaction>
  ): Promise<{ signature: string }> {
    const tx = createTransactionFromBase64(txResponse.message);
    const { blockhash, lastValidBlockHeight } = await updateBlockhash(
      tx,
      connection
    );

    const signed = await signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });

    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(
        `SOR transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    logger.info("SOR: transaction confirmed", { signature });
    return { signature };
  }
}
