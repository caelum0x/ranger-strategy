import { config } from "../config";

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

  async getPositions(
    publicKey: string,
    options?: {
      platforms?: string[];
      symbols?: string[];
      from?: string;
    }
  ): Promise<SorPosition[]> {
    if (!this.apiKey) {
      return [];
    }

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
      {
        headers: {
          "x-api-key": this.apiKey,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`SOR positions request failed: ${response.status}`);
    }

    const data = (await response.json()) as PositionsResponse;
    return data.positions || [];
  }

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
    if (!this.apiKey) {
      return null;
    }

    const response = await fetch(`${this.sorApiBaseUrl}/order_metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`SOR order metadata request failed: ${response.status}`);
    }

    return (await response.json()) as SorOrderMetadataResponse;
  }
}
