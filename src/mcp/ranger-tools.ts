/**
 * Ranger MCP Tool Server — TypeScript bridge for AI agent integration.
 *
 * Wraps our RangerDataApi + RangerSorClient as MCP-compatible tools
 * that AI agents (Claude, GPT, etc.) can call for Solana DeFi operations.
 *
 * Mirrors the official ranger-mcp Python server (ranger-agent-kit/perps-mcp)
 * but runs in our TypeScript stack alongside the strategy engine.
 *
 * Tools provided:
 *   SOR: get_trade_quote, increase_position, decrease_position, close_position, withdraw_balance
 *   Data: get_positions, get_trade_history, get_funding_rate_arbs, get_liquidations, etc.
 */
import { RangerDataApi } from "../ranger/data-api";
import { RangerSorClient } from "../ranger/sor-client";
import { logger } from "../utils/logger";

// ── MCP Tool Definition ─────────────────────────────────────────

export interface MCPTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  handler: (params: Record<string, any>) => Promise<any>;
}

// ── Ranger MCP Tool Server ──────────────────────────────────────

export class RangerMCPServer {
  private dataApi: RangerDataApi;
  private sorClient: RangerSorClient;
  private tools: Map<string, MCPTool> = new Map();

  constructor(dataApi?: RangerDataApi, sorClient?: RangerSorClient) {
    this.dataApi = dataApi || new RangerDataApi();
    this.sorClient = sorClient || new RangerSorClient();
    this.registerTools();
  }

  private registerTools(): void {
    // ── SOR Tools ──────────────────────────────────────────────

    this.register({
      name: "get_trade_quote",
      description: "Get a quote for a potential trade including price, liquidity, and routing across venues. Does NOT execute the trade.",
      parameters: {
        fee_payer: { type: "string", description: "Solana wallet public key", required: true },
        symbol: { type: "string", description: "Trading symbol (e.g., SOL, BTC)", required: true },
        side: { type: "string", description: "Long or Short", required: true },
        size: { type: "number", description: "Position size in base asset", required: true },
        collateral: { type: "number", description: "Collateral in USDC", required: true },
      },
      handler: async (params) => {
        return this.sorClient.getQuote({
          fee_payer: params.fee_payer,
          symbol: params.symbol,
          side: params.side,
          size: params.size,
          collateral: params.collateral,
        });
      },
    });

    this.register({
      name: "increase_position",
      description: "Open a new position or increase an existing one. Returns a base64 encoded transaction.",
      parameters: {
        fee_payer: { type: "string", description: "Solana wallet public key", required: true },
        symbol: { type: "string", description: "Trading symbol", required: true },
        side: { type: "string", description: "Long or Short", required: true },
        size: { type: "number", description: "Position size", required: true },
        collateral: { type: "number", description: "Collateral in USDC", required: true },
      },
      handler: async (params) => {
        return this.sorClient.increasePosition({
          fee_payer: params.fee_payer,
          symbol: params.symbol,
          side: params.side,
          size: params.size,
          collateral: params.collateral,
          size_denomination: params.symbol,
          collateral_denomination: "USDC",
          adjustment_type: "Increase",
        });
      },
    });

    this.register({
      name: "close_position",
      description: "Close an existing position completely.",
      parameters: {
        fee_payer: { type: "string", description: "Solana wallet public key", required: true },
        symbol: { type: "string", description: "Trading symbol", required: true },
        side: { type: "string", description: "Long or Short", required: true },
        adjustment_type: { type: "string", description: "CloseDrift, CloseFlash, CloseJupiter, or CloseAll" },
      },
      handler: async (params) => {
        return this.sorClient.closePosition({
          fee_payer: params.fee_payer,
          symbol: params.symbol,
          side: params.side,
          adjustment_type: params.adjustment_type || "CloseAll",
        });
      },
    });

    // ── Data Tools ─────────────────────────────────────────────

    this.register({
      name: "get_positions",
      description: "Retrieve user positions across all venues (Drift, Flash, Jupiter, Adrena).",
      parameters: {
        public_key: { type: "string", description: "Solana wallet public key", required: true },
      },
      handler: async (params) => {
        return this.dataApi.getPositions(params.public_key);
      },
    });

    this.register({
      name: "get_funding_rate_arbs",
      description: "Find funding rate arbitrage opportunities between platforms.",
      parameters: {
        min_diff: { type: "number", description: "Minimum rate difference (decimal)" },
      },
      handler: async (params) => {
        return this.dataApi.getFundingRateArbs(params.min_diff);
      },
    });

    this.register({
      name: "get_latest_liquidations",
      description: "Fetch the 10 most recent liquidation events.",
      parameters: {},
      handler: async () => {
        return this.dataApi.getLiquidationsLatest();
      },
    });

    this.register({
      name: "get_liquidation_capitulation_signals",
      description: "Identify market capitulation events based on liquidation volume Z-score.",
      parameters: {
        threshold: { type: "number", description: "Z-score threshold (default: 2.0)" },
      },
      handler: async (params) => {
        return this.dataApi.getLiquidationsCapitulation(undefined, undefined, params.threshold);
      },
    });

    this.register({
      name: "get_oi_weighted_funding_rates",
      description: "Get open-interest-weighted average funding rates per symbol across all platforms.",
      parameters: {},
      handler: async () => {
        return this.dataApi.getFundingRatesOiWeighted();
      },
    });

    this.register({
      name: "get_funding_rate_trend",
      description: "Calculate recent funding rate trend for a symbol.",
      parameters: {
        symbol: { type: "string", description: "Market symbol (e.g., SOL-PERP)", required: true },
      },
      handler: async (params) => {
        return this.dataApi.getFundingRatesTrend(params.symbol);
      },
    });

    this.register({
      name: "get_trade_history",
      description: "Retrieve trade history for a wallet across all venues.",
      parameters: {
        public_key: { type: "string", description: "Solana wallet public key", required: true },
      },
      handler: async (params) => {
        return this.dataApi.getTradeHistory(params.public_key);
      },
    });

    logger.info("Ranger MCP tools registered", {
      toolCount: this.tools.size,
      tools: [...this.tools.keys()],
    });
  }

  private register(tool: MCPTool): void {
    this.tools.set(tool.name, tool);
  }

  // ── Tool Execution ────────────────────────────────────────────

  async executeTool(name: string, params: Record<string, any>): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}. Available: ${[...this.tools.keys()].join(", ")}`);
    }

    logger.info(`MCP: executing tool ${name}`, { params });
    const result = await tool.handler(params);
    return result;
  }

  /**
   * Get tool definitions in MCP-compatible format.
   * Used by AI agents to discover available tools.
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: { type: string; properties: Record<string, any>; required: string[] };
  }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, val]) => [
            key,
            { type: val.type, description: val.description },
          ])
        ),
        required: Object.entries(tool.parameters)
          .filter(([, val]) => val.required)
          .map(([key]) => key),
      },
    }));
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }
}
