import fs from "fs";
import path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";

export interface VaultSnapshot {
  vault: string;
  aum: string;
  sharePrice?: string;
  highWaterMark?: string;
  strategyPositions: unknown[];
  fees: {
    admin?: string;
    manager?: string;
  };
  sourceEvent?: {
    type: string;
    signature?: string;
    slot?: number;
  };
  timestamp: number;
}

export interface RebalanceDecisionRecord {
  action: "rebalance" | "hold" | "reduce-risk";
  confidence: number;
  rationale: string;
  targetAllocation?: number;
  targetLeverage?: number;
  createdAt: number;
}

interface IndexerStoreFile {
  version: 1;
  updatedAt: number;
  snapshots: VaultSnapshot[];
  decisions: RebalanceDecisionRecord[];
}

const DEFAULT_STORE: IndexerStoreFile = {
  version: 1,
  updatedAt: 0,
  snapshots: [],
  decisions: [],
};

export class IndexerStore {
  private readonly filePath: string;

  constructor(filePath: string = config.indexerStorePath) {
    this.filePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
  }

  async saveSnapshot(snapshot: VaultSnapshot): Promise<void> {
    const store = this.read();
    store.snapshots.push(snapshot);
    store.snapshots = store.snapshots.slice(-250);
    store.updatedAt = Date.now();
    this.write(store);
  }

  getLatestSnapshot(): VaultSnapshot | null {
    const store = this.read();
    return store.snapshots.at(-1) || null;
  }

  getRecentSnapshots(limit = 20): VaultSnapshot[] {
    const store = this.read();
    return store.snapshots.slice(-limit);
  }

  async saveDecision(decision: RebalanceDecisionRecord): Promise<void> {
    const store = this.read();
    store.decisions.push(decision);
    store.decisions = store.decisions.slice(-100);
    store.updatedAt = Date.now();
    this.write(store);
  }

  getLatestDecision(): RebalanceDecisionRecord | null {
    const store = this.read();
    return store.decisions.at(-1) || null;
  }

  private read(): IndexerStoreFile {
    try {
      if (!fs.existsSync(this.filePath)) {
        return DEFAULT_STORE;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as IndexerStoreFile;

      if (parsed.version !== 1) {
        logger.warn("Unknown indexer store version, resetting", {
          version: (parsed as any).version,
        });
        return DEFAULT_STORE;
      }

      return {
        ...DEFAULT_STORE,
        ...parsed,
        snapshots: parsed.snapshots || [],
        decisions: parsed.decisions || [],
      };
    } catch (error) {
      logger.warn("Failed to read indexer store", { error });
      return DEFAULT_STORE;
    }
  }

  private write(store: IndexerStoreFile): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      logger.error("Failed to write indexer store", { error });
      throw error;
    }
  }
}
