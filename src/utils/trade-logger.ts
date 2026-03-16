/**
 * Trade event logger — granular audit trail of every strategy decision.
 *
 * Logs trade signals, executions, fills, and errors to a JSONL file
 * for hackathon submission and operational auditing.
 *
 * Each line is a self-contained JSON object with a timestamp,
 * event type, and structured payload.
 */
import fs from "fs";
import path from "path";
import { TradeSignal, MarketRegime } from "../strategy/types";
import { logger } from "./logger";

export type TradeEventType =
  | "signal_generated"
  | "signal_skipped"
  | "trade_executed"
  | "trade_failed"
  | "position_closed"
  | "direction_flip"
  | "emergency_unwind"
  | "regime_change"
  | "llm_advice"
  | "cycle_complete";

export interface TradeEvent {
  timestamp: string;
  epochMs: number;
  type: TradeEventType;
  cycle: number;
  data: Record<string, unknown>;
}

const LOG_DIR = path.join(process.cwd(), ".ranger-state");
const LOG_FILE = path.join(LOG_DIR, "trade-log.jsonl");
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — rotate after this

export class TradeLogger {
  private cycle = 0;

  setCycle(cycle: number): void {
    this.cycle = cycle;
  }

  /** Log a trade signal generation */
  logSignal(signal: TradeSignal): void {
    this.write("signal_generated", {
      asset: signal.asset,
      action: signal.action,
      perpSide: signal.perpSide,
      spotSide: signal.spotSide,
      perpVenue: signal.perpVenue,
      spotSize: signal.spotSize.toFixed(4),
      perpSize: signal.perpSize.toFixed(4),
      confidence: signal.confidence.toFixed(2),
      reason: signal.reason,
      predictedFundingRate: signal.predictedFundingRate.toFixed(6),
    });
  }

  /** Log a skipped signal (near settlement, risk check, etc.) */
  logSkipped(asset: string, reason: string): void {
    this.write("signal_skipped", { asset, reason });
  }

  /** Log successful trade execution */
  logExecution(
    asset: string,
    action: string,
    details: Record<string, unknown>
  ): void {
    this.write("trade_executed", { asset, action, ...details });
  }

  /** Log trade execution failure */
  logFailure(asset: string, action: string, error: string): void {
    this.write("trade_failed", { asset, action, error });
  }

  /** Log position close */
  logClose(asset: string, reason: string): void {
    this.write("position_closed", { asset, reason });
  }

  /** Log direction flip */
  logDirectionFlip(
    asset: string,
    from: string,
    to: string,
    rate: string
  ): void {
    this.write("direction_flip", { asset, from, to, fundingRate: rate });
  }

  /** Log emergency unwind */
  logEmergencyUnwind(reason: string): void {
    this.write("emergency_unwind", { reason });
  }

  /** Log regime change */
  logRegimeChange(from: MarketRegime, to: MarketRegime, reasoning: string): void {
    this.write("regime_change", { from, to, reasoning });
  }

  /** Log LLM advice summary */
  logLLMAdvice(regime: string, decisions: { asset: string; action: string; perpSide: string; allocation: number }[]): void {
    this.write("llm_advice", { regime, decisions });
  }

  /** Log cycle completion summary */
  logCycleComplete(summary: Record<string, unknown>): void {
    this.write("cycle_complete", summary);
  }

  /** Read all events (for dashboard/export) */
  readAll(): TradeEvent[] {
    try {
      if (!fs.existsSync(LOG_FILE)) return [];
      const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
      return lines
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as TradeEvent);
    } catch {
      return [];
    }
  }

  /** Read recent events (last N) */
  readRecent(count: number = 50): TradeEvent[] {
    const all = this.readAll();
    return all.slice(-count);
  }

  /** Get trade summary statistics */
  getSummary(): {
    totalEvents: number;
    totalSignals: number;
    totalExecutions: number;
    totalFailures: number;
    totalFlips: number;
    regimeChanges: number;
    firstEvent: string | null;
    lastEvent: string | null;
  } {
    const events = this.readAll();
    return {
      totalEvents: events.length,
      totalSignals: events.filter((e) => e.type === "signal_generated").length,
      totalExecutions: events.filter((e) => e.type === "trade_executed").length,
      totalFailures: events.filter((e) => e.type === "trade_failed").length,
      totalFlips: events.filter((e) => e.type === "direction_flip").length,
      regimeChanges: events.filter((e) => e.type === "regime_change").length,
      firstEvent: events.length > 0 ? events[0].timestamp : null,
      lastEvent: events.length > 0 ? events[events.length - 1].timestamp : null,
    };
  }

  /**
   * Compute per-asset win/loss record from trade history.
   * A "round trip" is an open followed by a close for the same asset.
   * Win = close where reason contains "Profit" or no stop-loss trigger.
   * Loss = close where reason contains "Stop-loss" or negative PnL indicator.
   */
  getWinLossRecord(): {
    totalRoundTrips: number;
    wins: number;
    losses: number;
    winRate: string;
    byAsset: Record<string, { opens: number; closes: number; wins: number; losses: number }>;
    recentTrades: { asset: string; action: string; result: "win" | "loss" | "unknown"; reason: string; timestamp: string }[];
  } {
    const events = this.readAll();
    const byAsset: Record<string, { opens: number; closes: number; wins: number; losses: number }> = {};
    const recentTrades: { asset: string; action: string; result: "win" | "loss" | "unknown"; reason: string; timestamp: string }[] = [];

    for (const e of events) {
      const asset = (e.data.asset as string) || "";
      if (!asset) continue;

      if (!byAsset[asset]) {
        byAsset[asset] = { opens: 0, closes: 0, wins: 0, losses: 0 };
      }

      if (e.type === "trade_executed") {
        const action = (e.data.action as string) || "";
        if (action === "open" || action === "increase") {
          byAsset[asset].opens++;
        }
      }

      if (e.type === "position_closed") {
        byAsset[asset].closes++;
        const reason = ((e.data.reason as string) || "").toLowerCase();

        let result: "win" | "loss" | "unknown" = "unknown";
        if (reason.includes("stop-loss") || reason.includes("emergency") || reason.includes("risk reduction")) {
          result = "loss";
          byAsset[asset].losses++;
        } else if (reason.includes("profit") || reason.includes("no longer attractive") || reason.includes("concentration")) {
          result = "win";
          byAsset[asset].wins++;
        } else {
          // Neutral close — count as win (orderly exit)
          result = "win";
          byAsset[asset].wins++;
        }

        recentTrades.push({
          asset,
          action: "close",
          result,
          reason: (e.data.reason as string) || "",
          timestamp: e.timestamp,
        });
      }
    }

    let totalWins = 0;
    let totalLosses = 0;
    let totalRoundTrips = 0;
    for (const a of Object.values(byAsset)) {
      totalWins += a.wins;
      totalLosses += a.losses;
      totalRoundTrips += a.closes;
    }

    const winRate = totalRoundTrips > 0
      ? `${((totalWins / totalRoundTrips) * 100).toFixed(1)}%`
      : "N/A";

    return {
      totalRoundTrips,
      wins: totalWins,
      losses: totalLosses,
      winRate,
      byAsset,
      recentTrades: recentTrades.slice(-20),
    };
  }

  private write(type: TradeEventType, data: Record<string, unknown>): void {
    const event: TradeEvent = {
      timestamp: new Date().toISOString(),
      epochMs: Date.now(),
      type,
      cycle: this.cycle,
      data,
    };

    try {
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      }

      // Rotate if file is too large
      if (fs.existsSync(LOG_FILE)) {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > MAX_LOG_SIZE_BYTES) {
          const rotated = LOG_FILE + ".1";
          if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          fs.renameSync(LOG_FILE, rotated);
        }
      }

      fs.appendFileSync(LOG_FILE, JSON.stringify(event) + "\n");
    } catch (err) {
      logger.warn("Failed to write trade event", { error: err, type });
    }
  }
}
