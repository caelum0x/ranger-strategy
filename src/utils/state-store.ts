/**
 * Persistent state store for crash recovery.
 *
 * Serializes strategy state to disk so the agent can resume
 * after restarts without losing funding/PnL tracking history.
 */
import fs from "fs";
import path from "path";
import Decimal from "decimal.js";
import { StrategyState, MarketRegime } from "../strategy/types";
import { logger } from "./logger";

interface SerializedState {
  version: 1;
  savedAt: number;
  /** When the agent first started (for APY calculation across restarts) */
  startTime?: number;
  state: {
    totalCapital: string;
    deployedCapital: string;
    idleCapital: string;
    totalPnl: string;
    totalFundingCollected: string;
    totalLendingCollected: string;
    totalTradingCosts: string;
    currentDrawdown: string;
    maxDrawdownHit: string;
    healthRatio: string;
    apyEstimate: string;
    lastRebalance: number;
    regime: MarketRegime;
    cycleCount: number;
    directionFlips: number;
  };
  peakEquity: string;
  predictorHistory: Record<string, string[]>;
}

const STATE_DIR = path.join(process.cwd(), ".ranger-state");
const STATE_FILE = path.join(STATE_DIR, "agent-state.json");

export class StateStore {
  /** Save strategy state to disk */
  save(
    state: StrategyState,
    peakEquity: Decimal,
    predictorHistory?: Map<string, Decimal[]>,
    startTime?: number
  ): void {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }

      const serialized: SerializedState = {
        version: 1,
        savedAt: Date.now(),
        startTime,
        state: {
          totalCapital: state.totalCapital.toString(),
          deployedCapital: state.deployedCapital.toString(),
          idleCapital: state.idleCapital.toString(),
          totalPnl: state.totalPnl.toString(),
          totalFundingCollected: state.totalFundingCollected.toString(),
          totalLendingCollected: state.totalLendingCollected.toString(),
          totalTradingCosts: state.totalTradingCosts.toString(),
          currentDrawdown: state.currentDrawdown.toString(),
          maxDrawdownHit: state.maxDrawdownHit.toString(),
          healthRatio: state.healthRatio.toString(),
          apyEstimate: state.apyEstimate.toString(),
          lastRebalance: state.lastRebalance,
          regime: state.regime,
          cycleCount: state.cycleCount,
          directionFlips: state.directionFlips,
        },
        peakEquity: peakEquity.toString(),
        predictorHistory: {},
      };

      if (predictorHistory) {
        for (const [asset, rates] of predictorHistory.entries()) {
          serialized.predictorHistory[asset] = rates.map((r) => r.toString());
        }
      }

      // Write atomically: write to temp file then rename
      const tmpFile = STATE_FILE + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(serialized, null, 2));
      fs.renameSync(tmpFile, STATE_FILE);

      logger.info("State saved to disk", {
        cycle: state.cycleCount,
        funding: state.totalFundingCollected.toFixed(4),
      });
    } catch (err) {
      logger.warn("Failed to save state", { error: err });
    }
  }

  /** Load state from disk. Returns null if no saved state or corrupted. */
  load(): {
    state: Partial<StrategyState>;
    peakEquity: Decimal;
    predictorHistory: Map<string, Decimal[]>;
    savedAt: number;
    startTime?: number;
  } | null {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;

      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const data: SerializedState = JSON.parse(raw);

      if (data.version !== 1) {
        logger.warn("Unknown state version, ignoring saved state");
        return null;
      }

      // Don't load stale state (>24h old)
      const ageMs = Date.now() - data.savedAt;
      if (ageMs > 24 * 3600 * 1000) {
        logger.info("Saved state is >24h old, starting fresh");
        return null;
      }

      const s = data.state;
      const state: Partial<StrategyState> = {
        totalCapital: new Decimal(s.totalCapital),
        deployedCapital: new Decimal(s.deployedCapital),
        idleCapital: new Decimal(s.idleCapital),
        totalPnl: new Decimal(s.totalPnl),
        totalFundingCollected: new Decimal(s.totalFundingCollected),
        totalLendingCollected: new Decimal(s.totalLendingCollected),
        totalTradingCosts: new Decimal(s.totalTradingCosts),
        currentDrawdown: new Decimal(s.currentDrawdown),
        maxDrawdownHit: new Decimal(s.maxDrawdownHit),
        healthRatio: new Decimal(s.healthRatio),
        apyEstimate: new Decimal(s.apyEstimate),
        lastRebalance: s.lastRebalance,
        regime: s.regime,
        cycleCount: s.cycleCount,
        directionFlips: s.directionFlips,
      };

      const predictorHistory = new Map<string, Decimal[]>();
      for (const [asset, rates] of Object.entries(data.predictorHistory)) {
        predictorHistory.set(
          asset,
          rates.map((r) => new Decimal(r))
        );
      }

      logger.info("Loaded saved state from disk", {
        savedAt: new Date(data.savedAt).toISOString(),
        ageMinutes: Math.round(ageMs / 60000),
        cycle: s.cycleCount,
        funding: s.totalFundingCollected,
      });

      return {
        state,
        peakEquity: new Decimal(data.peakEquity),
        predictorHistory,
        savedAt: data.savedAt,
        startTime: data.startTime,
      };
    } catch (err) {
      logger.warn("Failed to load saved state", { error: err });
      return null;
    }
  }

  /** Delete saved state */
  clear(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
      }
    } catch {
      // ignore
    }
  }
}
