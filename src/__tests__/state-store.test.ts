import fs from "fs";
import path from "path";
import Decimal from "decimal.js";
import { StateStore } from "../utils/state-store";
import { StrategyState } from "../strategy/types";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const STATE_DIR = path.join(process.cwd(), ".ranger-state");
const STATE_FILE = path.join(STATE_DIR, "agent-state.json");

function makeState(overrides: Partial<StrategyState> = {}): StrategyState {
  return {
    totalCapital: new Decimal("1000"),
    deployedCapital: new Decimal("500"),
    idleCapital: new Decimal("500"),
    positions: [],
    totalPnl: new Decimal("10"),
    totalFundingCollected: new Decimal("5.5"),
    totalLendingCollected: new Decimal("1.2"),
    totalTradingCosts: new Decimal("0.8"),
    currentDrawdown: new Decimal("0.5"),
    maxDrawdownHit: new Decimal("1.2"),
    healthRatio: new Decimal("3.5"),
    apyEstimate: new Decimal("12.5"),
    lastRebalance: Date.now(),
    regime: "neutral",
    cycleCount: 42,
    directionFlips: 3,
    ...overrides,
  };
}

describe("StateStore", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore();
    // Clean up state file before each test
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  afterAll(() => {
    // Clean up after all tests
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    if (fs.existsSync(STATE_DIR)) {
      try {
        fs.rmdirSync(STATE_DIR);
      } catch {
        // ignore if not empty
      }
    }
  });

  it("saves and loads state", () => {
    const state = makeState();
    const peakEquity = new Decimal("1050");
    const history = new Map<string, Decimal[]>();
    history.set("SOL", [new Decimal("0.10"), new Decimal("0.12")]);

    store.save(state, peakEquity, history);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.state.cycleCount).toBe(42);
    expect(loaded!.state.totalFundingCollected!.eq(new Decimal("5.5"))).toBe(true);
    expect(loaded!.peakEquity.eq(new Decimal("1050"))).toBe(true);
    expect(loaded!.predictorHistory.get("SOL")).toHaveLength(2);
  });

  it("returns null when no saved state exists", () => {
    const loaded = store.load();
    expect(loaded).toBeNull();
  });

  it("clears saved state", () => {
    const state = makeState();
    store.save(state, new Decimal("1000"));

    store.clear();

    const loaded = store.load();
    expect(loaded).toBeNull();
  });

  it("saves without predictor history", () => {
    const state = makeState();
    store.save(state, new Decimal("1000"));

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.predictorHistory.size).toBe(0);
  });
});
