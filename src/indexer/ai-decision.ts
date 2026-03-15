import { OpenRouterClient } from "../ai/openrouter";
import { config } from "../config";
import { logger } from "../utils/logger";
import { IndexerStore, RebalanceDecisionRecord, VaultSnapshot } from "./db";

interface AIDecisionResponse {
  action: "rebalance" | "hold" | "reduce-risk";
  confidence: number;
  rationale: string;
  targetAllocation?: number;
  targetLeverage?: number;
}

export class IndexerDecisionEngine {
  private readonly store: IndexerStore;
  private readonly llm?: OpenRouterClient;

  constructor(store: IndexerStore = new IndexerStore()) {
    this.store = store;
    this.llm = config.openRouterApiKey ? new OpenRouterClient() : undefined;
  }

  async decideRebalance(): Promise<RebalanceDecisionRecord> {
    const latest = this.store.getLatestSnapshot();
    const recent = this.store.getRecentSnapshots(12);

    if (!latest) {
      return {
        action: "hold",
        confidence: 0.2,
        rationale: "No indexed vault state yet; waiting for the first webhook event.",
        createdAt: Date.now(),
      };
    }

    const decision = this.llm
      ? await this.decideWithLLM(latest, recent)
      : this.decideHeuristically(latest, recent);

    await this.store.saveDecision(decision);
    return decision;
  }

  private async decideWithLLM(
    latest: VaultSnapshot,
    recent: VaultSnapshot[]
  ): Promise<RebalanceDecisionRecord> {
    try {
      const prompt = [
        "You are deciding whether a Solana delta-neutral vault should rebalance.",
        "Return JSON only.",
        JSON.stringify({
          latest,
          recent,
          objective:
            "Preserve delta-neutral exposure, react to large AUM moves, rising fees, or strategy count changes.",
          responseSchema: {
            action: '"rebalance" | "hold" | "reduce-risk"',
            confidence: "number 0..1",
            rationale: "string",
            targetAllocation: "optional number 0..1",
            targetLeverage: "optional number 0..2",
          },
        }),
      ].join("\n");

      const response = await this.llm!.chatJSON<AIDecisionResponse>(
        [{ role: "user", content: prompt }],
        { temperature: 0.1, maxTokens: 500 }
      );

      return {
        action: response.action,
        confidence: this.clamp(response.confidence, 0, 1),
        rationale: response.rationale,
        targetAllocation:
          response.targetAllocation === undefined
            ? undefined
            : this.clamp(response.targetAllocation, 0, 1),
        targetLeverage:
          response.targetLeverage === undefined
            ? undefined
            : this.clamp(response.targetLeverage, 0, 2),
        createdAt: Date.now(),
      };
    } catch (error) {
      logger.warn("Indexer LLM decision failed, using heuristic fallback", {
        error,
      });
      return this.decideHeuristically(latest, recent);
    }
  }

  private decideHeuristically(
    latest: VaultSnapshot,
    recent: VaultSnapshot[]
  ): RebalanceDecisionRecord {
    const previous = recent.at(-2);
    if (!previous) {
      return {
        action: "hold",
        confidence: 0.45,
        rationale: "Only one snapshot is available; keep the current allocation until a trend forms.",
        createdAt: Date.now(),
      };
    }

    const latestAum = Number(latest.aum);
    const previousAum = Number(previous.aum);
    const aumChange = previousAum > 0 ? Math.abs(latestAum - previousAum) / previousAum : 0;
    const strategyCountChanged =
      latest.strategyPositions.length !== previous.strategyPositions.length;

    if (aumChange >= 0.05 || strategyCountChanged) {
      return {
        action: "rebalance",
        confidence: strategyCountChanged ? 0.82 : 0.68,
        rationale: strategyCountChanged
          ? "Strategy composition changed since the last indexed event."
          : `Vault AUM moved ${(aumChange * 100).toFixed(2)}% since the prior snapshot.`,
        targetAllocation: 0.5,
        targetLeverage: 1,
        createdAt: Date.now(),
      };
    }

    const managerFees = Number(latest.fees.manager || 0);
    const adminFees = Number(latest.fees.admin || 0);
    if (managerFees + adminFees > 0 && aumChange >= 0.02) {
      return {
        action: "reduce-risk",
        confidence: 0.61,
        rationale: "Fees are accruing while AUM is moving; de-risk before the next rebalance cycle.",
        targetAllocation: 0.35,
        targetLeverage: 0.75,
        createdAt: Date.now(),
      };
    }

    return {
      action: "hold",
      confidence: 0.57,
      rationale: "Vault state is stable across the most recent indexed snapshots.",
      createdAt: Date.now(),
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
