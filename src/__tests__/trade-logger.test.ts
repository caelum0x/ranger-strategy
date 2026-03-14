import fs from "fs";
import path from "path";
import Decimal from "decimal.js";
import { TradeLogger } from "../utils/trade-logger";

// Use a temp directory for test logs
const TEST_DIR = path.join(process.cwd(), ".ranger-state-test");
const TEST_LOG = path.join(TEST_DIR, "trade-log.jsonl");

// Override the log path for testing
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("TradeLogger", () => {
  let tradeLogger: TradeLogger;

  beforeEach(() => {
    tradeLogger = new TradeLogger();
    tradeLogger.setCycle(1);
  });

  afterEach(() => {
    // Clean up test log from default location
    const defaultLog = path.join(process.cwd(), ".ranger-state", "trade-log.jsonl");
    if (fs.existsSync(defaultLog)) {
      fs.unlinkSync(defaultLog);
    }
  });

  it("logs signals and reads them back", () => {
    tradeLogger.logSignal({
      asset: "SOL",
      action: "open",
      spotVenue: "drift",
      perpVenue: "drift",
      spotSide: "long",
      perpSide: "short",
      spotSize: new Decimal("10"),
      perpSize: new Decimal("10"),
      confidence: new Decimal("0.8"),
      reason: "Test signal",
      predictedFundingRate: new Decimal("0.25"),
    });

    const events = tradeLogger.readRecent(10);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("signal_generated");
    expect(lastEvent.cycle).toBe(1);
    expect(lastEvent.data.asset).toBe("SOL");
    expect(lastEvent.data.action).toBe("open");
  });

  it("logs different event types", () => {
    tradeLogger.logExecution("SOL", "open", { txSig: "abc123" });
    tradeLogger.logFailure("ETH", "open", "Insufficient collateral");
    tradeLogger.logClose("SOL", "Funding rate below threshold");
    tradeLogger.logDirectionFlip("SOL", "short", "long", "0.15");
    tradeLogger.logEmergencyUnwind("Health ratio critical");
    tradeLogger.logRegimeChange("neutral", "bull", "Strong positive funding");

    const summary = tradeLogger.getSummary();
    expect(summary.totalExecutions).toBeGreaterThanOrEqual(1);
    expect(summary.totalFailures).toBeGreaterThanOrEqual(1);
    expect(summary.totalFlips).toBeGreaterThanOrEqual(1);
    expect(summary.regimeChanges).toBeGreaterThanOrEqual(1);
  });

  it("tracks cycle number correctly", () => {
    tradeLogger.setCycle(5);
    tradeLogger.logSkipped("BTC", "Near settlement");

    const events = tradeLogger.readRecent(1);
    expect(events[events.length - 1].cycle).toBe(5);
  });

  it("returns empty summary when no events exist", () => {
    const freshLogger = new TradeLogger();
    // Clear any existing log
    const defaultLog = path.join(process.cwd(), ".ranger-state", "trade-log.jsonl");
    if (fs.existsSync(defaultLog)) {
      fs.unlinkSync(defaultLog);
    }

    const summary = freshLogger.getSummary();
    expect(summary.totalEvents).toBe(0);
    expect(summary.firstEvent).toBeNull();
    expect(summary.lastEvent).toBeNull();
  });

  it("logs cycle completion with summary data", () => {
    tradeLogger.logCycleComplete({
      cycle: 1,
      regime: "neutral",
      positions: 2,
      totalPnl: "0.0050",
      healthRatio: "1.50",
    });

    const events = tradeLogger.readRecent(1);
    const last = events[events.length - 1];
    expect(last.type).toBe("cycle_complete");
    expect(last.data.regime).toBe("neutral");
  });

  it("logs LLM advice", () => {
    tradeLogger.logLLMAdvice("bull", [
      { asset: "SOL", action: "open", perpSide: "short", allocation: 0.4 },
      { asset: "ETH", action: "skip", perpSide: "long", allocation: 0 },
    ]);

    const events = tradeLogger.readRecent(1);
    const last = events[events.length - 1];
    expect(last.type).toBe("llm_advice");
    expect(last.data.regime).toBe("bull");
    expect((last.data.decisions as any[]).length).toBe(2);
  });
});
