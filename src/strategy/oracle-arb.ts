/**
 * Oracle Limit Order Arbitrage — cross-exchange arb via oracle offsets.
 *
 * From Drift Workshop (00:14:39):
 *   "Oracle limit orders: buy/sell based on an offset between the Drift price
 *    and the Oracle price — useful for funding rate arbitrage and basis trades"
 *
 * And (00:27:43):
 *   "Oracle limit order demo: setting a buy order 50 cents below the Oracle
 *    price, watching the order price update in real time"
 *
 * This strategy exploits price discrepancies between Drift's mark price
 * and the oracle (Pyth) price:
 *   - When mark < oracle: buy on Drift (underpriced) → sell elsewhere
 *   - When mark > oracle: sell on Drift (overpriced) → buy elsewhere
 *
 * The oracle offset ensures orders automatically track the oracle,
 * so we only get filled when the basis spread is in our favor.
 *
 * Combined with our cross-venue funding rate intelligence (Drift vs Flash vs Adrena),
 * this creates a full cross-exchange arbitrage system.
 */
import {
  DriftClient,
  BN,
  PositionDirection,
  OrderType,
  BASE_PRECISION,
  PRICE_PRECISION,
  convertToNumber,
  PostOnlyParams,
} from "@drift-labs/sdk";
import { logger } from "../utils/logger";
import { fetchPriceBySymbol } from "../utils/pyth-oracle";

// ── Types ───────────────────────────────────────────────────────

export interface OracleArbConfig {
  /** Perp market index */
  marketIndex: number;
  /** Asset symbol for Pyth price cross-reference */
  symbol: string;
  /** Minimum basis spread to trigger arb (bps) */
  minBasisSpreadBps: number;
  /** Order size in base asset */
  orderSize: number;
  /** Max position for arb (prevents overexposure) */
  maxPosition: number;
  /** Oracle offset for buy orders (negative ticks below oracle) */
  buyOffset: number;
  /** Oracle offset for sell orders (positive ticks above oracle) */
  sellOffset: number;
}

const DEFAULT_CONFIG: OracleArbConfig = {
  marketIndex: 0,
  symbol: "SOL",
  minBasisSpreadBps: 10, // 0.10% minimum spread
  orderSize: 0.5,
  maxPosition: 5.0,
  buyOffset: -100,  // 100 ticks below oracle (~$0.10 for SOL)
  sellOffset: 100,  // 100 ticks above oracle
};

interface BasisAnalysis {
  markPrice: number;
  oraclePrice: number;
  pythPrice: number | null;
  basisBps: number; // mark vs oracle in bps
  crossBasisBps: number | null; // mark vs pyth in bps
  signal: "buy" | "sell" | "none";
}

// ── Oracle Arb Strategy ─────────────────────────────────────────

export class OracleArbStrategy {
  private client: DriftClient;
  private configs: OracleArbConfig[];
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private stats = {
    analysisCount: 0,
    arbSignals: 0,
    ordersPlaced: 0,
    basisCapture: 0, // cumulative basis captured in bps
  };

  constructor(
    client: DriftClient,
    configs: Partial<OracleArbConfig>[] = [{}]
  ) {
    this.client = client;
    this.configs = configs.map((c) => ({ ...DEFAULT_CONFIG, ...c }));
  }

  start(intervalMs = 5_000): void {
    if (this.running) return;
    this.running = true;

    this.intervalId = setInterval(() => {
      this.scanForArbs().catch((err) => {
        logger.warn("Oracle arb scan error", { error: String(err) });
      });
    }, intervalMs);

    logger.info("Oracle arb strategy started", {
      markets: this.configs.map((c) => `${c.symbol} (idx ${c.marketIndex})`),
      minBasis: this.configs.map((c) => `${c.minBasisSpreadBps}bps`),
    });
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("Oracle arb strategy stopped", { stats: this.stats });
  }

  getStats() {
    return { ...this.stats };
  }

  // ── Core Logic ────────────────────────────────────────────────

  private async scanForArbs(): Promise<void> {
    for (const config of this.configs) {
      const analysis = await this.analyzeBasis(config);
      this.stats.analysisCount++;

      if (analysis.signal !== "none") {
        this.stats.arbSignals++;
        await this.executeArbOrder(config, analysis);
      }
    }
  }

  /**
   * Analyze the basis spread between Drift mark price and oracle.
   * Cross-references with Pyth Hermes for independent price validation.
   *
   * From Drift Workshop: oracle limit orders exploit mark-oracle divergence.
   */
  private async analyzeBasis(config: OracleArbConfig): Promise<BasisAnalysis> {
    // Get Drift oracle and mark price
    const oracleData = this.client.getOracleDataForPerpMarket(config.marketIndex);
    const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);

    const perpMarket = this.client.getPerpMarketAccount(config.marketIndex);
    const markPrice = perpMarket
      ? convertToNumber(perpMarket.amm.lastMarkPriceTwap, PRICE_PRECISION)
      : oraclePrice;

    // Cross-reference with Pyth Hermes (independent source)
    let pythPrice: number | null = null;
    try {
      const pythData = await fetchPriceBySymbol(config.symbol);
      pythPrice = pythData?.price ?? null;
    } catch {
      // Pyth unavailable — use Drift oracle only
    }

    // Calculate basis
    const basisBps = oraclePrice > 0
      ? ((markPrice - oraclePrice) / oraclePrice) * 10000
      : 0;

    const crossBasisBps = pythPrice && pythPrice > 0
      ? ((markPrice - pythPrice) / pythPrice) * 10000
      : null;

    // Determine signal
    let signal: "buy" | "sell" | "none" = "none";

    if (Math.abs(basisBps) >= config.minBasisSpreadBps) {
      if (basisBps < -config.minBasisSpreadBps) {
        // Mark is significantly below oracle → Drift is underpriced → BUY
        signal = "buy";
      } else if (basisBps > config.minBasisSpreadBps) {
        // Mark is significantly above oracle → Drift is overpriced → SELL
        signal = "sell";
      }
    }

    // Validate with Pyth cross-reference (if available)
    if (signal !== "none" && crossBasisBps !== null) {
      // If Pyth disagrees with our signal, skip (could be oracle lag)
      if (signal === "buy" && crossBasisBps > 0) {
        signal = "none"; // Pyth says mark is actually above true price
      }
      if (signal === "sell" && crossBasisBps < 0) {
        signal = "none"; // Pyth says mark is actually below true price
      }
    }

    return { markPrice, oraclePrice, pythPrice, basisBps, crossBasisBps, signal };
  }

  /**
   * Place an oracle-offset order to capture the basis spread.
   *
   * From Drift Workshop (00:14:39):
   *   "Oracle limit orders: buy/sell based on an offset between
   *    the Drift price and the Oracle price"
   *
   * Using oracle offset means the order automatically tracks the oracle,
   * so it only fills when the basis is in our favor.
   */
  private async executeArbOrder(
    config: OracleArbConfig,
    analysis: BasisAnalysis
  ): Promise<void> {
    // Check position limits
    try {
      const user = this.client.getUser();
      const perpPos = user.getPerpPosition(config.marketIndex);
      const currentBase = perpPos
        ? Math.abs(convertToNumber(perpPos.baseAssetAmount, BASE_PRECISION))
        : 0;

      if (currentBase >= config.maxPosition) return;
    } catch {
      return;
    }

    const orderSize = new BN(
      Math.floor(config.orderSize * 1e9).toString()
    );

    const direction = analysis.signal === "buy"
      ? PositionDirection.LONG
      : PositionDirection.SHORT;
    const offset = analysis.signal === "buy"
      ? config.buyOffset
      : config.sellOffset;

    try {
      await this.client.placePerpOrder({
        orderType: OrderType.LIMIT,
        marketIndex: config.marketIndex,
        direction,
        baseAssetAmount: orderSize,
        oraclePriceOffset: offset,
        postOnly: PostOnlyParams.MUST_POST_ONLY,
        immediateOrCancel: true,
      } as any);

      this.stats.ordersPlaced++;
      this.stats.basisCapture += Math.abs(analysis.basisBps);

      logger.info("Oracle arb: order placed", {
        symbol: config.symbol,
        signal: analysis.signal,
        basisBps: analysis.basisBps.toFixed(1),
        markPrice: analysis.markPrice.toFixed(4),
        oraclePrice: analysis.oraclePrice.toFixed(4),
        pythPrice: analysis.pythPrice?.toFixed(4) || "N/A",
        offset,
      });
    } catch (err) {
      logger.debug("Oracle arb: order failed", { error: String(err) });
    }
  }
}
