/**
 * Lightweight HTTP monitoring server for the vault agent.
 *
 * Uses Node's built-in `http` module (no Express dependency).
 * Exposes JSON endpoints for real-time monitoring and demo dashboards.
 */
import http from "http";
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

type RouteHandler = (
  req: http.IncomingMessage
) => Promise<unknown> | unknown;

export class MonitorServer {
  private server: http.Server | null = null;
  private routes: Map<string, RouteHandler> = new Map();

  constructor(private port: number = 3000) {}

  /** Register a GET route handler */
  route(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      // CORS headers for dashboard access
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      const url = new URL(req.url || "/", `http://localhost:${this.port}`);
      const handler = this.routes.get(url.pathname);

      if (!handler) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      try {
        const data = await handler(req);
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } catch (err) {
        res.writeHead(500);
        res.end(
          JSON.stringify({
            error: "Internal server error",
            message: err instanceof Error ? err.message : String(err),
          })
        );
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        logger.info(`Monitor server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Calculate a single 0-100 health score for the vault.
   * Useful for at-a-glance monitoring dashboards.
   */
  static calculateHealthScore(params: {
    healthRatio: Decimal;
    drawdownPct: Decimal;
    deltaImbalance: Decimal;
    capitalUtilization: Decimal;
  }): { score: number; grade: "A" | "B" | "C" | "D" | "F" } {
    let score = 100;

    // Health ratio: penalize below 2.0, critical below 1.1
    const hr = params.healthRatio.toNumber();
    if (hr < 1.1) score -= 50;
    else if (hr < 1.5) score -= 30;
    else if (hr < 2.0) score -= 15;
    else if (hr < 3.0) score -= 5;

    // Drawdown: penalize above 1%
    const dd = params.drawdownPct.toNumber();
    if (dd > 3) score -= 30;
    else if (dd > 2) score -= 15;
    else if (dd > 1) score -= 5;

    // Delta imbalance: penalize above 3%
    const di = params.deltaImbalance.abs().toNumber();
    if (di > 0.05) score -= 15;
    else if (di > 0.03) score -= 5;

    // Capital utilization: penalize very low (<20%) or very high (>90%)
    const cu = params.capitalUtilization.toNumber();
    if (cu < 0.1) score -= 10;
    else if (cu > 0.95) score -= 10;

    score = Math.max(0, Math.min(100, score));

    const grade =
      score >= 90 ? "A" as const :
      score >= 75 ? "B" as const :
      score >= 60 ? "C" as const :
      score >= 40 ? "D" as const :
      "F" as const;

    return { score, grade };
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
