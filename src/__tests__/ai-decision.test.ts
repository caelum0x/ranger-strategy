import fs from "fs";
import path from "path";
import { IndexerDecisionEngine } from "../indexer/ai-decision";
import { IndexerStore } from "../indexer/db";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("IndexerDecisionEngine", () => {
  const storePath = path.join(process.cwd(), ".ranger-state", "indexer-ai-test.json");

  afterEach(() => {
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
    }
  });

  it("rebalances on large AUM changes", async () => {
    const store = new IndexerStore(storePath);
    await store.saveSnapshot({
      vault: "vault-1",
      aum: "100",
      strategyPositions: [],
      fees: {},
      timestamp: Date.now() - 1000,
    });
    await store.saveSnapshot({
      vault: "vault-1",
      aum: "110",
      strategyPositions: [],
      fees: {},
      timestamp: Date.now(),
    });

    const engine = new IndexerDecisionEngine(store);
    const decision = await engine.decideRebalance();

    expect(decision.action).toBe("rebalance");
  });
});
