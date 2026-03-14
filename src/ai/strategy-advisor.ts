/**
 * LLM-powered Strategy Advisor — the AI brain of Ranger.
 *
 * Replaces/augments the EMA-based FundingPredictor with LLM analysis:
 * 1. Funding rate prediction using market context
 * 2. Natural language trade reasoning
 * 3. Position sizing and regime classification
 *
 * The advisor receives structured market data (funding rates, positions,
 * on-chain analysis) and returns structured decisions via JSON parsing.
 */
import Decimal from "decimal.js";
import { OpenRouterClient, ChatMessage } from "./openrouter";
import { FundingRate, MarketRegime, Position, StrategyState } from "../strategy/types";
import { FundingPrediction } from "../strategy/predictor";
import { FundingAnalysis } from "../drift/funding";
import { logger } from "../utils/logger";

/** Full LLM analysis result combining all three features */
export interface LLMStrategyAdvice {
  /** Regime classification */
  regime: MarketRegime;
  regimeReasoning: string;

  /** Per-asset funding predictions */
  predictions: LLMFundingPrediction[];

  /** Per-asset trade decisions with reasoning */
  decisions: LLMTradeDecision[];

  /** Overall portfolio reasoning (natural language) */
  portfolioReasoning: string;
}

export interface LLMFundingPrediction {
  asset: string;
  predictedRateAnnualized: number;
  confidence: number;
  direction: "positive" | "negative";
  signalStrength: "strong" | "moderate" | "weak";
  reasoning: string;
}

export interface LLMTradeDecision {
  asset: string;
  action: "open" | "hold" | "close" | "skip";
  perpSide: "short" | "long";
  /** Fraction of idle capital to allocate (0-1) */
  allocationFraction: number;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are the AI strategy advisor for Ranger, a USDC delta-neutral funding rate harvester on Drift (Solana).

Your job: analyze live market data and make structured decisions about funding rate trades.

**How the strategy works:**
- We open delta-neutral positions: perp + spot hedge to collect funding payments
- Positive funding → short perp collects from longs → we short perp + long spot
- Negative funding → long perp collects from shorts → we long perp + short spot
- We target minimum 10% APY from funding alone
- Max leverage: 2x, max drawdown: 3%, health ratio floor: 1.10

**Your responsibilities:**
1. **Regime classification**: Classify the market as bull/bear/neutral/volatile based on funding rates and market structure
2. **Funding prediction**: Predict whether current funding rates will persist, increase, or mean-revert
3. **Trade decisions**: For each asset, decide whether to open/hold/close positions with specific allocation sizing
4. **Reasoning**: Explain every decision in plain language for audit trail

**Important constraints:**
- This is a $20 POC — capital preservation is paramount
- We can only trade on Drift (on-chain Solana perps + spot)
- Devnet spot oracles may be stale — factor this into confidence
- All responses must be valid JSON matching the schema exactly

Always respond with valid JSON. No markdown, no explanations outside the JSON.`;

export class StrategyAdvisor {
  private client: OpenRouterClient;
  /** Cache last advice to avoid redundant LLM calls */
  private lastAdvice: LLMStrategyAdvice | null = null;
  private lastAdviceTime = 0;
  /** Minimum interval between LLM calls (5 minutes) */
  private readonly MIN_CALL_INTERVAL_MS = 5 * 60 * 1000;

  constructor(client?: OpenRouterClient) {
    this.client = client || new OpenRouterClient();
  }

  /**
   * Get full strategy advice from the LLM.
   * Combines funding prediction, regime classification, and trade decisions.
   */
  async analyze(ctx: {
    fundingRates: FundingRate[];
    positions: Position[];
    state: StrategyState;
    onChainAnalyses?: FundingAnalysis[];
    targetAssets: string[];
  }): Promise<LLMStrategyAdvice> {
    // Rate-limit LLM calls
    const now = Date.now();
    if (this.lastAdvice && now - this.lastAdviceTime < this.MIN_CALL_INTERVAL_MS) {
      logger.info("LLM advice cached — skipping call");
      return this.lastAdvice;
    }

    const userPrompt = this.buildPrompt(ctx);

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    try {
      const advice = await this.client.chatJSON<LLMStrategyAdvice>(messages, {
        temperature: 0.2,
        maxTokens: 2048,
      });

      // Validate and sanitize
      this.validateAdvice(advice, ctx.targetAssets);

      this.lastAdvice = advice;
      this.lastAdviceTime = now;

      logger.info("LLM strategy advice received", {
        regime: advice.regime,
        predictions: advice.predictions.length,
        decisions: advice.decisions.map((d) => `${d.asset}:${d.action}`),
      });

      return advice;
    } catch (err: any) {
      logger.error("LLM strategy advisor failed — falling back to heuristics", {
        error: err.message,
      });
      return this.fallbackAdvice(ctx);
    }
  }

  /**
   * Convert LLM predictions to the FundingPrediction interface
   * used by the existing StrategyEngine.
   */
  toFundingPredictions(advice: LLMStrategyAdvice): FundingPrediction[] {
    return advice.predictions.map((p) => ({
      asset: p.asset,
      predictedRate: new Decimal(p.predictedRateAnnualized),
      confidence: new Decimal(p.confidence),
      direction: p.direction,
      signalStrength: p.signalStrength,
      signals: {
        emaSignal: new Decimal(p.predictedRateAnnualized),
        momentumSignal: new Decimal(0),
        meanReversionSignal: new Decimal(0),
        crossAssetSignal: new Decimal(0),
      },
    }));
  }

  /**
   * Get natural language reasoning for the last analysis.
   */
  getLastReasoning(): string | null {
    if (!this.lastAdvice) return null;
    const parts = [
      `**Market Regime: ${this.lastAdvice.regime}** — ${this.lastAdvice.regimeReasoning}`,
      "",
      "**Trade Decisions:**",
      ...this.lastAdvice.decisions.map(
        (d) => `- ${d.asset}: ${d.action.toUpperCase()} ${d.perpSide} perp (${(d.allocationFraction * 100).toFixed(0)}% allocation) — ${d.reasoning}`
      ),
      "",
      `**Portfolio:** ${this.lastAdvice.portfolioReasoning}`,
    ];
    return parts.join("\n");
  }

  private buildPrompt(ctx: {
    fundingRates: FundingRate[];
    positions: Position[];
    state: StrategyState;
    onChainAnalyses?: FundingAnalysis[];
    targetAssets: string[];
  }): string {
    const ratesTable = ctx.fundingRates
      .map((r) => ({
        asset: r.asset,
        annualizedAPY: `${r.annualizedRate.mul(100).toFixed(2)}%`,
        hourlyRate: r.rate.toFixed(6),
        direction: r.annualizedRate.gte(0) ? "positive (shorts collect)" : "negative (longs collect)",
        nextSettlement: new Date(r.nextSettlement).toISOString(),
      }));

    const positionsTable = ctx.positions.map((p) => ({
      asset: p.asset,
      side: p.side,
      venue: p.venue,
      notional: `$${p.notionalValue.toFixed(2)}`,
      pnl: `$${p.unrealizedPnl.toFixed(4)}`,
      leverage: `${p.leverage.toFixed(2)}x`,
    }));

    const onChainTable = (ctx.onChainAnalyses || []).map((a) => ({
      asset: a.asset,
      premium: `${a.premium.mul(100).toFixed(4)}%`,
      longShortImbalance: `${a.longShortImbalance.mul(100).toFixed(2)}%`,
      momentum: a.momentum,
      isAttractive: a.isAttractive,
      attractiveDirection: a.attractiveDirection || "none",
      confidence: `${a.confidence.mul(100).toFixed(0)}%`,
    }));

    return `Analyze the following market data and provide your strategy advice as JSON.

**Current State:**
- Total capital: $${ctx.state.totalCapital.toFixed(2)}
- Deployed: $${ctx.state.deployedCapital.toFixed(2)}
- Idle: $${ctx.state.idleCapital.toFixed(2)}
- Health ratio: ${ctx.state.healthRatio.toFixed(4)}
- Cycle: #${ctx.state.cycleCount}
- Current drawdown: ${ctx.state.currentDrawdown.toFixed(2)}%
- Funding collected so far: $${ctx.state.totalFundingCollected.toFixed(4)}
- Trading costs so far: $${ctx.state.totalTradingCosts.toFixed(4)}

**Live Funding Rates:**
${JSON.stringify(ratesTable, null, 2)}

**Current Positions:**
${positionsTable.length > 0 ? JSON.stringify(positionsTable, null, 2) : "None"}

**On-Chain Analysis:**
${onChainTable.length > 0 ? JSON.stringify(onChainTable, null, 2) : "Not available"}

**Target Assets:** ${ctx.targetAssets.join(", ")}

Respond with this exact JSON schema:
{
  "regime": "bull" | "bear" | "neutral" | "volatile",
  "regimeReasoning": "string explaining why",
  "predictions": [
    {
      "asset": "SOL",
      "predictedRateAnnualized": 0.25,
      "confidence": 0.7,
      "direction": "positive" | "negative",
      "signalStrength": "strong" | "moderate" | "weak",
      "reasoning": "why you predict this"
    }
  ],
  "decisions": [
    {
      "asset": "SOL",
      "action": "open" | "hold" | "close" | "skip",
      "perpSide": "short" | "long",
      "allocationFraction": 0.4,
      "reasoning": "why this decision"
    }
  ],
  "portfolioReasoning": "overall portfolio strategy explanation"
}`;
  }

  /**
   * Validate LLM output and clamp values to safe ranges.
   */
  private validateAdvice(advice: LLMStrategyAdvice, targetAssets: string[]): void {
    // Ensure regime is valid
    const validRegimes: MarketRegime[] = ["bull", "bear", "neutral", "volatile"];
    if (!validRegimes.includes(advice.regime)) {
      advice.regime = "neutral";
    }

    // Ensure all target assets have predictions and decisions
    for (const asset of targetAssets) {
      if (!advice.predictions.find((p) => p.asset === asset)) {
        advice.predictions.push({
          asset,
          predictedRateAnnualized: 0,
          confidence: 0.3,
          direction: "positive",
          signalStrength: "weak",
          reasoning: "No LLM prediction — defaulting to conservative",
        });
      }
      if (!advice.decisions.find((d) => d.asset === asset)) {
        advice.decisions.push({
          asset,
          action: "skip",
          perpSide: "short",
          allocationFraction: 0,
          reasoning: "No LLM decision — skipping",
        });
      }
    }

    // Clamp allocation fractions to safe range
    for (const d of advice.decisions) {
      d.allocationFraction = Math.max(0, Math.min(0.5, d.allocationFraction));
    }

    // Clamp confidence
    for (const p of advice.predictions) {
      p.confidence = Math.max(0.1, Math.min(0.95, p.confidence));
    }
  }

  /**
   * Fallback when LLM is unavailable — use simple heuristics.
   */
  private fallbackAdvice(ctx: {
    fundingRates: FundingRate[];
    positions: Position[];
    state: StrategyState;
    targetAssets: string[];
  }): LLMStrategyAdvice {
    const predictions: LLMFundingPrediction[] = ctx.fundingRates
      .filter((r) => ctx.targetAssets.includes(r.asset))
      .map((r) => ({
        asset: r.asset,
        predictedRateAnnualized: r.annualizedRate.toNumber(),
        confidence: 0.5,
        direction: (r.annualizedRate.gte(0) ? "positive" : "negative") as "positive" | "negative",
        signalStrength: (r.annualizedRate.abs().gt(0.15) ? "strong" : r.annualizedRate.abs().gt(0.08) ? "moderate" : "weak") as "strong" | "moderate" | "weak",
        reasoning: "Heuristic fallback — LLM unavailable, using current rate as prediction",
      }));

    const decisions: LLMTradeDecision[] = predictions.map((p) => ({
      asset: p.asset,
      action: (p.signalStrength === "weak" ? "skip" : "open") as "open" | "skip",
      perpSide: (p.direction === "positive" ? "short" : "long") as "short" | "long",
      allocationFraction: p.signalStrength === "strong" ? 0.4 : 0.25,
      reasoning: "Heuristic fallback — using current funding rate strength",
    }));

    return {
      regime: "neutral",
      regimeReasoning: "LLM unavailable — defaulting to neutral regime",
      predictions,
      decisions,
      portfolioReasoning: "Heuristic mode: allocating based on current funding rate magnitude",
    };
  }
}
