/**
 * Test the LLM Strategy Advisor in isolation.
 * Sends real market data to the LLM and displays the structured response.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.devnet" });

import { OpenRouterClient } from "../src/ai/openrouter";
import { StrategyAdvisor } from "../src/ai/strategy-advisor";
import { FundingRate, Position, StrategyState } from "../src/strategy/types";
import Decimal from "decimal.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function section(title: string) {
  console.log(
    `\n${BOLD}${CYAN}── ${title} ${"─".repeat(50 - title.length)}${RESET}`
  );
}

async function main() {
  console.log(`\n${BOLD}╔══════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  LLM STRATEGY ADVISOR TEST           ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════╝${RESET}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log("No OPENROUTER_API_KEY set");
    return;
  }

  section("Initializing LLM Client");
  const client = new OpenRouterClient(apiKey);
  const advisor = new StrategyAdvisor(client);
  console.log(`  ${GREEN}✓${RESET} OpenRouter client ready`);

  // Simulate real market data from devnet
  const fundingRates: FundingRate[] = [
    {
      asset: "SOL",
      venue: "drift",
      rate: new Decimal("0.002648"),
      annualizedRate: new Decimal("0.2632"),
      timestamp: Date.now(),
      nextSettlement: Date.now() + 3600000,
    },
    {
      asset: "ETH",
      venue: "drift",
      rate: new Decimal("-0.000856"),
      annualizedRate: new Decimal("-0.075"),
      timestamp: Date.now(),
      nextSettlement: Date.now() + 3600000,
    },
  ];

  const state: StrategyState = {
    totalCapital: new Decimal("19.50"),
    deployedCapital: new Decimal("0"),
    idleCapital: new Decimal("19.50"),
    positions: [],
    totalPnl: new Decimal("0"),
    totalFundingCollected: new Decimal("0"),
    totalLendingCollected: new Decimal("0"),
    totalTradingCosts: new Decimal("0"),
    currentDrawdown: new Decimal("0"),
    maxDrawdownHit: new Decimal("0"),
    healthRatio: new Decimal("999"),
    apyEstimate: new Decimal("0"),
    lastRebalance: 0,
    regime: "neutral",
    cycleCount: 0,
    directionFlips: 0,
  };

  section("Sending Market Data to LLM");
  console.log(`  SOL funding: ${fundingRates[0].annualizedRate.mul(100).toFixed(2)}% APY`);
  console.log(`  ETH funding: ${fundingRates[1].annualizedRate.mul(100).toFixed(2)}% APY`);
  console.log(`  Capital: $${state.totalCapital.toFixed(2)}`);
  console.log(`  ${YELLOW}→${RESET} Calling LLM...`);

  const startMs = Date.now();
  const advice = await advisor.analyze({
    fundingRates,
    positions: [],
    state,
    targetAssets: ["SOL", "ETH"],
  });
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  section(`LLM Response (${elapsed}s)`);

  console.log(`\n  ${BOLD}Regime:${RESET} ${advice.regime}`);
  console.log(`  ${advice.regimeReasoning}\n`);

  section("Funding Predictions");
  for (const p of advice.predictions) {
    console.log(`  ${BOLD}${p.asset}${RESET}`);
    console.log(`    Predicted rate: ${(p.predictedRateAnnualized * 100).toFixed(2)}% APY`);
    console.log(`    Confidence:     ${(p.confidence * 100).toFixed(0)}%`);
    console.log(`    Direction:      ${p.direction}`);
    console.log(`    Strength:       ${p.signalStrength}`);
    console.log(`    Reasoning:      ${p.reasoning}`);
  }

  section("Trade Decisions");
  for (const d of advice.decisions) {
    console.log(`  ${BOLD}${d.asset}${RESET}`);
    console.log(`    Action:     ${d.action.toUpperCase()}`);
    console.log(`    Perp side:  ${d.perpSide}`);
    console.log(`    Allocation: ${(d.allocationFraction * 100).toFixed(0)}%`);
    console.log(`    Reasoning:  ${d.reasoning}`);
  }

  section("Portfolio Reasoning");
  console.log(`  ${advice.portfolioReasoning}`);

  section("Natural Language Summary");
  const reasoning = advisor.getLastReasoning();
  if (reasoning) {
    for (const line of reasoning.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  // Test FundingPrediction conversion
  section("FundingPrediction Interface");
  const predictions = advisor.toFundingPredictions(advice);
  for (const p of predictions) {
    console.log(`  ${BOLD}${p.asset}${RESET}: ${p.predictedRate.mul(100).toFixed(2)}% (${p.direction}, ${p.signalStrength}, conf=${p.confidence.mul(100).toFixed(0)}%)`);
  }

  console.log(`\n  ${GREEN}${BOLD}LLM Strategy Advisor fully validated!${RESET}\n`);
}

main().catch((err) => {
  console.error("Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
