import fs from "fs";
import path from "path";
import { IndexerStore } from "../indexer/db";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("IndexerStore", () => {
  const storePath = path.join(process.cwd(), ".ranger-state", "test-indexer-state.json");

  beforeEach(() => {
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
    }
  });

  afterAll(() => {
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
    }
  });

  it("persists snapshots and decisions", async () => {
    const store = new IndexerStore(storePath);

    await store.saveSnapshot({
      vault: "vault-1",
      aum: "1000000",
      strategyPositions: [],
      fees: {},
      timestamp: Date.now(),
    });

    await store.saveDecision({
      action: "hold",
      confidence: 0.5,
      rationale: "stable",
      createdAt: Date.now(),
    });

    expect(store.getLatestSnapshot()?.vault).toBe("vault-1");
    expect(store.getLatestDecision()?.action).toBe("hold");
  });
});
