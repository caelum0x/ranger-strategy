/**
 * TypeScript client for the Drift Gateway Rust sidecar.
 *
 * The gateway (gateway/) is a self-hosted REST/WS server that signs and
 * broadcasts Drift transactions in Rust. It handles retry logic, multi-RPC
 * broadcasting, and priority fees natively — much faster than JS tx building.
 *
 * Usage:
 *   1. Start the gateway: DRIFT_GATEWAY_KEY=<key> ./drift-gateway --port 8080 <rpc>
 *   2. Instantiate:        const gw = new GatewayClient("http://127.0.0.1:8080");
 *   3. Place order:        await gw.placeOrders([{ marketIndex: 0, ... }]);
 *
 * Reference: gateway/README.md for full API spec.
 */
import { logger } from "../utils/logger";

// ── Types (from gateway/src/types.rs) ───────────────────────────

export interface GatewayOrderParams {
  marketIndex: number;
  marketType: "perp" | "spot";
  direction: "long" | "short";
  orderType: "limit" | "market" | "triggerMarket" | "triggerLimit" | "oracle";
  amount: number;
  price?: number;
  oraclePriceOffset?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  maxTs?: number;
  userOrderId?: number;
}

export interface GatewayModifyParams {
  orderId?: number;
  userOrderId?: number;
  amount?: number;
  price?: number;
  reduceOnly?: boolean;
  maxTs?: number;
}

export interface GatewayCancelParams {
  marketIndex?: number;
  marketType?: "perp" | "spot";
  orderId?: number;
  userOrderId?: number;
}

export interface CancelAndPlaceRequest {
  cancel: GatewayCancelParams;
  place: { orders: GatewayOrderParams[] };
}

export interface GatewayOrder {
  orderId: number;
  userOrderId: number;
  marketIndex: number;
  marketType: string;
  direction: string;
  orderType: string;
  baseAssetAmount: string;
  price: string;
  oraclePriceOffset: string;
  status: string;
  slot: number;
}

export interface GatewayPosition {
  marketIndex: number;
  marketType: string;
  amount: string;
  averageEntry: string;
  unrealizedPnl: string;
  liquidationPrice?: string;
}

export interface GatewayMarket {
  marketIndex: number;
  symbol: string;
  marketType: string;
  oraclePrice: string;
  markPrice?: string;
}

export interface GatewaySwapRequest {
  amount: string;
  outAsset: string;
  inAsset: string;
  slippageBps?: number;
}

export interface TxResponse {
  tx: string; // transaction signature
}

// ── Client ──────────────────────────────────────────────────────

export class GatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "http://127.0.0.1:8080") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ── Health ──────────────────────────────────────────────────

  async isAlive(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/v2/balance`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ── Markets ─────────────────────────────────────────────────

  async getMarkets(): Promise<GatewayMarket[]> {
    return this.get<GatewayMarket[]>("/v2/markets");
  }

  // ── Orders ──────────────────────────────────────────────────

  async getOrders(
    marketIndex?: number,
    marketType?: "perp" | "spot"
  ): Promise<GatewayOrder[]> {
    const params = new URLSearchParams();
    if (marketIndex !== undefined) params.set("marketIndex", String(marketIndex));
    if (marketType) params.set("marketType", marketType);
    const qs = params.toString();
    return this.get<GatewayOrder[]>(`/v2/orders${qs ? `?${qs}` : ""}`);
  }

  async placeOrders(
    orders: GatewayOrderParams[],
    subAccountId?: number
  ): Promise<TxResponse> {
    const params = new URLSearchParams();
    if (subAccountId !== undefined)
      params.set("subAccountId", String(subAccountId));
    const qs = params.toString();

    logger.info("Gateway: placing orders", {
      count: orders.length,
      markets: orders.map((o) => `${o.marketType}:${o.marketIndex}`),
    });
    return this.post<TxResponse>(
      `/v2/orders${qs ? `?${qs}` : ""}`,
      { orders }
    );
  }

  async modifyOrders(orders: GatewayModifyParams[]): Promise<TxResponse> {
    logger.info("Gateway: modifying orders", { count: orders.length });
    return this.patch<TxResponse>("/v2/orders", { orders });
  }

  async cancelOrders(params: GatewayCancelParams): Promise<TxResponse> {
    logger.info("Gateway: canceling orders", params);
    return this.del<TxResponse>("/v2/orders", params);
  }

  async cancelAndPlace(request: CancelAndPlaceRequest): Promise<TxResponse> {
    logger.info("Gateway: atomic cancel+place", {
      placeCount: request.place.orders.length,
    });
    return this.post<TxResponse>("/v2/orders/cancelAndPlace", request);
  }

  // ── Positions ───────────────────────────────────────────────

  async getPositions(): Promise<GatewayPosition[]> {
    return this.get<GatewayPosition[]>("/v2/positions");
  }

  async getPositionInfo(
    marketIndex: number
  ): Promise<GatewayPosition & { liquidationPrice?: string }> {
    return this.get(`/v2/positionInfo/${marketIndex}`);
  }

  // ── Account Info ────────────────────────────────────────────

  async getMarginInfo(): Promise<{
    totalCollateral: string;
    freeCollateral: string;
    marginRequirement: string;
    leverage: string;
  }> {
    return this.get("/v2/marginInfo");
  }

  async getLeverage(): Promise<{ leverage: string }> {
    return this.get("/v2/leverage");
  }

  async setLeverage(
    marketIndex: number,
    leverage: number
  ): Promise<TxResponse> {
    return this.post<TxResponse>("/v2/leverage", {
      marketIndex,
      leverage,
    });
  }

  async getCollateral(): Promise<{
    total: string;
    free: string;
  }> {
    return this.get("/v2/collateral");
  }

  async getBalance(): Promise<{ balance: string }> {
    return this.get("/v2/balance");
  }

  // ── Swaps ───────────────────────────────────────────────────

  async swap(request: GatewaySwapRequest): Promise<TxResponse> {
    logger.info("Gateway: swap", {
      inAsset: request.inAsset,
      outAsset: request.outAsset,
      amount: request.amount,
    });
    return this.post<TxResponse>("/v2/swap", request);
  }

  // ── High-Level Helpers ──────────────────────────────────────

  /**
   * Place a delta-neutral pair via the gateway.
   * Atomically cancels existing orders and places spot + perp legs.
   */
  async placeDeltaNeutralPair(params: {
    asset: string;
    perpMarketIndex: number;
    spotMarketIndex: number;
    baseAmount: number;
    perpDirection: "long" | "short";
    perpPrice?: number;
    spotPrice?: number;
  }): Promise<TxResponse> {
    const spotDirection =
      params.perpDirection === "short" ? "long" : "short";

    const orders: GatewayOrderParams[] = [
      {
        marketIndex: params.spotMarketIndex,
        marketType: "spot",
        direction: spotDirection,
        orderType: params.spotPrice ? "limit" : "market",
        amount: params.baseAmount,
        price: params.spotPrice,
      },
      {
        marketIndex: params.perpMarketIndex,
        marketType: "perp",
        direction: params.perpDirection,
        orderType: params.perpPrice ? "limit" : "market",
        amount: params.baseAmount,
        price: params.perpPrice,
      },
    ];

    return this.cancelAndPlace({
      cancel: {}, // cancel all
      place: { orders },
    });
  }

  // ── HTTP primitives ─────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Gateway GET ${path}: ${resp.status} ${body}`);
    }
    return resp.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Gateway POST ${path}: ${resp.status} ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Gateway PATCH ${path}: ${resp.status} ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  private async del<T>(path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Gateway DELETE ${path}: ${resp.status} ${text}`);
    }
    return resp.json() as Promise<T>;
  }
}
