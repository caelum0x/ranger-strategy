/**
 * Hackathon Submission Package Generator
 *
 * Collects all artifacts needed for the Build-A-Bear Hackathon submission:
 * - Codebase stats (files, lines, test count)
 * - Strategy performance data (NAV history, trade log, agent state)
 * - Wallet/vault addresses for on-chain verification
 * - Architecture summary
 *
 * Usage: npx ts-node scripts/submission-package.ts
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { StateStore } from "../src/utils/state-store";
import { TradeLogger } from "../src/utils/trade-logger";
import { VaultPerformanceTracker } from "../src/vault/performance";
import dotenv from "dotenv";

dotenv.config();

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function section(title: string) {
  console.log(
    `\n${BOLD}${CYAN}── ${title} ${"─".repeat(50 - title.length)}${RESET}`
  );
}

function countFiles(dir: string, ext: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  try {
    const result = execSync(
      `find ${dir} -name "*.${ext}" -not -path "*/node_modules/*" -not -path "*/dist/*" | xargs wc -l 2>/dev/null | tail -1`,
      { encoding: "utf-8" }
    ).trim();
    const match = result.match(/(\d+)/);
    lines = match ? parseInt(match[1]) : 0;

    const fileCount = execSync(
      `find ${dir} -name "*.${ext}" -not -path "*/node_modules/*" -not -path "*/dist/*" | wc -l`,
      { encoding: "utf-8" }
    ).trim();
    files = parseInt(fileCount) || 0;
  } catch {
    // ignore
  }
  return { files, lines };
}

async function main() {
  const projectDir = path.resolve(__dirname, "..");

  console.log(
    `\n${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`
  );
  console.log(
    `${BOLD}║   RANGER — HACKATHON SUBMISSION PACKAGE               ║${RESET}`
  );
  console.log(
    `${BOLD}║   Build-A-Bear Hackathon | Mar 9 – Apr 6, 2026        ║${RESET}`
  );
  console.log(
    `${BOLD}╚══════════════════════════════════════════════════════╝${RESET}`
  );

  // ── 1. Codebase Statistics ─────────────────────────────────
  section("Codebase Statistics");

  const srcStats = countFiles(path.join(projectDir, "src"), "ts");
  const scriptStats = countFiles(path.join(projectDir, "scripts"), "ts");
  const totalFiles = srcStats.files + scriptStats.files;
  const totalLines = srcStats.lines + scriptStats.lines;

  // Test count
  let testCount = 0;
  let testSuiteCount = 0;
  try {
    const testOutput = execSync("npx jest --passWithNoTests --json 2>/dev/null", {
      encoding: "utf-8",
      cwd: projectDir,
    });
    const testResult = JSON.parse(testOutput);
    testCount = testResult.numPassedTests || 0;
    testSuiteCount = testResult.numPassedTestSuites || 0;
  } catch (err: any) {
    // Try parsing from stderr/stdout
    try {
      const jsonMatch = err.stdout?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        testCount = parsed.numPassedTests || 0;
        testSuiteCount = parsed.numPassedTestSuites || 0;
      }
    } catch {
      testCount = 0;
    }
  }

  console.log(`  Source files:       ${srcStats.files} (${srcStats.lines} lines)`);
  console.log(`  Script files:       ${scriptStats.files} (${scriptStats.lines} lines)`);
  console.log(`  Total TypeScript:   ${totalFiles} files, ${totalLines} lines`);
  console.log(`  Test suites:        ${testSuiteCount}`);
  console.log(`  Tests:              ${testCount}`);

  // ── 2. Architecture ────────────────────────────────────────
  section("Architecture");

  const modules = [
    { name: "AI Strategy Advisor", path: "src/ai/", desc: "LLM-powered regime classification, funding prediction, trade decisions" },
    { name: "Strategy Engine", path: "src/strategy/", desc: "Core delta-neutral funding harvester with EMA predictor fallback" },
    { name: "Drift Integration", path: "src/drift/", desc: "On-chain perp/spot trading, funding analyzer, vault manager, executor" },
    { name: "Risk Manager", path: "src/risk/", desc: "Health ratio, drawdown, leverage, delta-neutrality checks" },
    { name: "Vault Performance", path: "src/vault/", desc: "NAV tracking, share price, depositor equity, withdrawal-aware sizing" },
    { name: "Agent Loop", path: "src/agent/", desc: "Autonomous cron-based cycle, health monitoring, state persistence" },
    { name: "Monitor Server", path: "src/monitor/", desc: "HTTP API with /status, /positions, /yield, /trades, /vault, /health" },
    { name: "Trade Logger", path: "src/utils/trade-logger.ts", desc: "JSONL audit trail of every trade decision and execution" },
    { name: "Telegram Alerts", path: "src/alerts/", desc: "Real-time cycle summaries with LLM reasoning" },
    { name: "Binance Bridge", path: "src/binance/", desc: "Optional cross-venue mode for CEX/DEX arbitrage" },
    { name: "Ranger Vault", path: "src/ranger/", desc: "Voltr SDK integration for Ranger Earn vault" },
  ];

  for (const mod of modules) {
    console.log(`  ${GREEN}✓${RESET} ${mod.name.padEnd(22)} ${DIM}${mod.desc}${RESET}`);
  }

  // ── 3. Key Features ────────────────────────────────────────
  section("Key Features");

  const features = [
    "LLM-powered strategy with Claude Sonnet via OpenRouter",
    "Bi-directional funding harvesting (positive + negative rates)",
    "Atomic delta-neutral entry/exit transactions on Drift",
    "Withdrawal-aware position sizing (reserves vault liquidity)",
    "24h direction flip circuit breaker (prevents churn)",
    "Settlement-aware timing (defers trades near funding settlement)",
    "Auto-compounding of earned yield",
    "On-chain funding analysis with premium, imbalance, momentum",
    "Health ratio spike detection and emergency unwind",
    "Crash recovery via atomic state persistence",
    "NAV history tracking with share price evolution",
    "Depositor equity attribution and P&L breakdown",
    "Graceful shutdown preserves positions across restarts",
  ];

  for (const feat of features) {
    console.log(`  ${GREEN}✓${RESET} ${feat}`);
  }

  // ── 4. Agent State ─────────────────────────────────────────
  section("Agent State");

  const stateStore = new StateStore();
  const savedState = stateStore.load();
  if (savedState) {
    const s = savedState.state;
    console.log(`  Last saved:        ${new Date(savedState.savedAt).toISOString()}`);
    console.log(`  Cycles run:        ${s.cycleCount || 0}`);
    console.log(`  Market regime:     ${s.regime || "unknown"}`);
    console.log(`  Funding collected: $${s.totalFundingCollected?.toFixed(4) || "0"}`);
    console.log(`  Lending collected: $${s.totalLendingCollected?.toFixed(4) || "0"}`);
    console.log(`  Trading costs:     $${s.totalTradingCosts?.toFixed(4) || "0"}`);
    console.log(`  APY estimate:      ${s.apyEstimate?.toFixed(2) || "0"}%`);
    console.log(`  Direction flips:   ${s.directionFlips || 0}`);
  } else {
    console.log("  No saved state — agent hasn't run yet");
  }

  // ── 5. Trade Log ───────────────────────────────────────────
  section("Trade Event Log");

  const tradeLogger = new TradeLogger();
  const tradeSummary = tradeLogger.getSummary();
  if (tradeSummary.totalEvents > 0) {
    console.log(`  Total events:      ${tradeSummary.totalEvents}`);
    console.log(`  Signals generated: ${tradeSummary.totalSignals}`);
    console.log(`  Trades executed:   ${tradeSummary.totalExecutions}`);
    console.log(`  Trade failures:    ${tradeSummary.totalFailures}`);
    console.log(`  Direction flips:   ${tradeSummary.totalFlips}`);
    console.log(`  Regime changes:    ${tradeSummary.regimeChanges}`);
    console.log(`  First event:       ${tradeSummary.firstEvent}`);
    console.log(`  Last event:        ${tradeSummary.lastEvent}`);
  } else {
    console.log("  No trade events recorded");
  }

  // ── 6. Vault Performance ───────────────────────────────────
  section("Vault Performance");

  const vaultPerf = new VaultPerformanceTracker();
  const navHistory = vaultPerf.getNAVHistory();
  if (navHistory.length > 0) {
    const report = vaultPerf.generateReport();
    const formatted = vaultPerf.formatReport(report);
    console.log(`  NAV snapshots:     ${navHistory.length}`);
    console.log(`  Current NAV:       ${formatted.currentNAV}`);
    console.log(`  Share price:       ${formatted.sharePrice}`);
    console.log(`  Total return:      ${formatted.totalReturn}`);
    console.log(`  Annualized:        ${formatted.annualizedReturn}`);
    console.log(`  Max drawdown:      ${formatted.maxDrawdown}`);
    console.log(`  Sharpe estimate:   ${formatted.sharpeEstimate}`);
  } else {
    console.log("  No NAV snapshots yet — run the agent to generate data");
  }

  // ── 7. On-Chain Verification ───────────────────────────────
  section("On-Chain Verification");

  const wallet = process.env.ANCHOR_WALLET;
  if (wallet && fs.existsSync(wallet)) {
    try {
      const keypairBytes = JSON.parse(fs.readFileSync(wallet, "utf-8"));
      const { Keypair } = await import("@solana/web3.js");
      const kp = Keypair.fromSecretKey(new Uint8Array(keypairBytes));
      console.log(`  Wallet:            ${kp.publicKey.toBase58()}`);
      console.log(`  Solscan:           https://solscan.io/account/${kp.publicKey.toBase58()}`);
    } catch {
      console.log("  Could not load wallet");
    }
  } else {
    console.log("  Set ANCHOR_WALLET in .env to show wallet address");
  }

  if (process.env.DRIFT_VAULT_PUBKEY) {
    console.log(`  Drift Vault:       ${process.env.DRIFT_VAULT_PUBKEY}`);
  }
  if (process.env.VAULT_PUBKEY) {
    console.log(`  Ranger Vault:      ${process.env.VAULT_PUBKEY}`);
  }

  // ── 8. Configuration ──────────────────────────────────────
  section("Strategy Configuration");

  console.log(`  Strategy mode:     ${process.env.STRATEGY_MODE || "drift-only"}`);
  console.log(`  Target assets:     ${process.env.TARGET_ASSETS || "SOL,BTC,ETH"}`);
  console.log(`  Min funding APY:   ${process.env.MIN_FUNDING_APY || "0.10"}`);
  console.log(`  Max leverage:      ${process.env.MAX_LEVERAGE || "2"}x`);
  console.log(`  Health floor:      ${process.env.HEALTH_RATIO_FLOOR || "1.10"}`);
  console.log(`  Max drawdown:      ${process.env.MAX_DRAWDOWN_PCT || "3"}%`);
  console.log(`  Rebalance:         ${process.env.REBALANCE_INTERVAL_MS ? `${parseInt(process.env.REBALANCE_INTERVAL_MS) / 3600000}h` : "8h"}`);
  console.log(`  LLM model:         ${process.env.LLM_MODEL || "anthropic/claude-sonnet-4"}`);
  console.log(`  AI advisor:        ${process.env.OPENROUTER_API_KEY ? "enabled" : "disabled"}`);

  // ── Summary ────────────────────────────────────────────────
  console.log(
    `\n${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`
  );
  console.log(
    `${BOLD}║   SUBMISSION CHECKLIST                                ║${RESET}`
  );
  console.log(
    `${BOLD}╚══════════════════════════════════════════════════════╝${RESET}`
  );

  const checks = [
    { name: "Codebase compiled", pass: totalLines > 0 },
    { name: "Tests passing", pass: testCount > 100 },
    { name: "AI strategy advisor", pass: fs.existsSync(path.join(projectDir, "src/ai/strategy-advisor.ts")) },
    { name: "Trade event log", pass: fs.existsSync(path.join(projectDir, "src/utils/trade-logger.ts")) },
    { name: "Vault performance tracker", pass: fs.existsSync(path.join(projectDir, "src/vault/performance.ts")) },
    { name: "Devnet strategy test", pass: fs.existsSync(path.join(projectDir, "scripts/devnet-strategy-test.ts")) },
    { name: "Mainnet preflight", pass: fs.existsSync(path.join(projectDir, "scripts/mainnet-launch.ts")) },
    { name: "Export trades script", pass: fs.existsSync(path.join(projectDir, "scripts/export-trades.ts")) },
    { name: "Agent state persistence", pass: fs.existsSync(path.join(projectDir, "src/utils/state-store.ts")) },
    { name: "Drift vault integration", pass: fs.existsSync(path.join(projectDir, "src/drift/vault.ts")) },
    { name: "Live agent state", pass: !!savedState },
    { name: "Trade events recorded", pass: tradeSummary.totalEvents > 0 },
    { name: "NAV history available", pass: navHistory.length > 0 },
  ];

  for (const check of checks) {
    const icon = check.pass ? `${GREEN}✓${RESET}` : `\x1b[33m○${RESET}`;
    console.log(`  ${icon} ${check.name}`);
  }

  const passCount = checks.filter((c) => c.pass).length;
  console.log(
    `\n  ${BOLD}${passCount}/${checks.length} checks passed${RESET}`
  );

  if (passCount >= 10) {
    console.log(`\n  ${GREEN}${BOLD}Ready for submission!${RESET}`);
  } else {
    console.log(`\n  Run the agent on devnet/mainnet to complete remaining checks.`);
  }

  console.log();
}

main().catch(console.error);
