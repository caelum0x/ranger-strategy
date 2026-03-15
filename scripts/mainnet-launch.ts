/**
 * Mainnet launch preflight — validates everything before starting the agent.
 *
 * Checks:
 * 1. Environment variables set correctly
 * 2. Keypair exists and loads
 * 3. Wallet has SOL for fees
 * 4. Drift account has USDC collateral
 * 5. RPC endpoint responds
 * 6. OpenRouter API key works (optional)
 * 7. All target asset markets exist
 *
 * Usage: npx ts-node scripts/mainnet-launch.ts
 */
import dotenv from "dotenv";

// Load mainnet env if it exists, else default .env
const envFile = process.argv.includes("--devnet") ? ".env.devnet" : ".env.mainnet";
dotenv.config({ path: envFile });

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "../src/config";
import * as fs from "fs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  critical: boolean;
}

async function main() {
  const isDevnet = process.argv.includes("--devnet");
  const env = isDevnet ? "devnet" : "mainnet-beta";

  console.log(`\n${BOLD}╔════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  RANGER — ${env.toUpperCase()} LAUNCH PREFLIGHT${" ".repeat(Math.max(0, 22 - env.length))}║${RESET}`);
  console.log(`${BOLD}╚════════════════════════════════════════════════╝${RESET}\n`);

  const checks: Check[] = [];

  // 1. Environment
  checks.push({
    name: "Drift environment",
    pass: config.driftEnv === env,
    detail: `DRIFT_ENV=${config.driftEnv} (expected ${env})`,
    critical: true,
  });

  checks.push({
    name: "Strategy mode",
    pass: config.strategyMode === "drift-only",
    detail: `STRATEGY_MODE=${config.strategyMode}`,
    critical: false,
  });

  checks.push({
    name: "Helius RPC URL",
    pass: !!process.env.HELIUS_RPC_URL && process.env.HELIUS_RPC_URL.includes("helius"),
    detail: process.env.HELIUS_RPC_URL
      ? process.env.HELIUS_RPC_URL.replace(/api-key=[^&]+/, "api-key=***")
      : "Not set — required for priority fee estimation",
    critical: true,
  });

  // 2. Keypair
  const keypairPath = process.env.ANCHOR_WALLET || "";
  let keypair: Keypair | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    keypair = Keypair.fromSecretKey(new Uint8Array(raw));
    checks.push({
      name: "Keypair loads",
      pass: true,
      detail: `${keypairPath} → ${keypair.publicKey.toBase58()}`,
      critical: true,
    });
  } catch (err: any) {
    checks.push({
      name: "Keypair loads",
      pass: false,
      detail: `Failed: ${err.message}`,
      critical: true,
    });
  }

  // 3. RPC connection
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  try {
    const version = await connection.getVersion();
    checks.push({
      name: "RPC responds",
      pass: true,
      detail: `${config.solanaRpcUrl} (solana-core ${version["solana-core"]})`,
      critical: true,
    });
  } catch (err: any) {
    checks.push({
      name: "RPC responds",
      pass: false,
      detail: `Failed: ${err.message}`,
      critical: true,
    });
  }

  // 4. SOL balance (for tx fees)
  if (keypair) {
    try {
      const balance = await connection.getBalance(keypair.publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;
      checks.push({
        name: "SOL for fees",
        pass: solBalance > 0.01,
        detail: `${solBalance.toFixed(4)} SOL`,
        critical: true,
      });
    } catch {
      checks.push({
        name: "SOL for fees",
        pass: false,
        detail: "Could not check balance",
        critical: true,
      });
    }
  }

  // 5. Drift account check
  if (keypair) {
    try {
      const { DriftManager } = await import("../src/drift/client");
      const drift = new DriftManager({ keypair: keypairPath });
      await drift.initialize();

      const collateral = drift.getFreeCollateral();
      checks.push({
        name: "Drift USDC collateral",
        pass: collateral.gt(1),
        detail: `$${collateral.toFixed(2)} free collateral`,
        critical: true,
      });

      // Check each target asset market
      const rates = await drift.getFundingRates();
      for (const asset of config.targetAssets) {
        const rate = rates.find((r) => r.asset === asset);
        checks.push({
          name: `${asset} market exists`,
          pass: !!rate,
          detail: rate
            ? `Funding: ${rate.annualizedRate.mul(100).toFixed(2)}% APY`
            : "Market not found",
          critical: true,
        });
      }

      await drift.shutdown();
    } catch (err: any) {
      checks.push({
        name: "Drift connection",
        pass: false,
        detail: `Failed: ${err.message}`,
        critical: true,
      });
    }
  }

  // 6. OpenRouter API key
  if (config.openRouterApiKey) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
      });
      checks.push({
        name: "OpenRouter API",
        pass: res.ok,
        detail: res.ok ? "API key valid" : `HTTP ${res.status}`,
        critical: false,
      });
    } catch {
      checks.push({
        name: "OpenRouter API",
        pass: false,
        detail: "Could not reach API",
        critical: false,
      });
    }
  } else {
    checks.push({
      name: "OpenRouter API",
      pass: false,
      detail: "No API key — LLM advisor disabled, using EMA predictor",
      critical: false,
    });
  }

  // 7. Strategy parameters
  checks.push({
    name: "Max leverage",
    pass: config.maxLeverage.lte(3),
    detail: `${config.maxLeverage}x`,
    critical: false,
  });

  checks.push({
    name: "Health ratio floor",
    pass: config.healthRatioFloor.gte(1.05),
    detail: config.healthRatioFloor.toString(),
    critical: false,
  });

  checks.push({
    name: "Max drawdown",
    pass: config.maxDrawdownPct.lte(10),
    detail: `${config.maxDrawdownPct}%`,
    critical: false,
  });

  checks.push({
    name: "Delta checks",
    pass: !config.relaxDeltaChecks || isDevnet,
    detail: config.relaxDeltaChecks ? "RELAXED (devnet only!)" : "strict",
    critical: !isDevnet,
  });

  // ── Results ────────────────────────────────────────────────
  console.log(`${BOLD}${CYAN}── Preflight Results ────────────────────────────────${RESET}\n`);

  let criticalFails = 0;
  let warnings = 0;

  for (const check of checks) {
    const icon = check.pass
      ? `${GREEN}✓${RESET}`
      : check.critical
        ? `${RED}✗${RESET}`
        : `${YELLOW}!${RESET}`;
    console.log(`  ${icon} ${check.name}`);
    console.log(`    ${check.detail}`);

    if (!check.pass && check.critical) criticalFails++;
    if (!check.pass && !check.critical) warnings++;
  }

  console.log(`\n${BOLD}── Summary ─────────────────────────────────────────${RESET}`);
  console.log(`  Passed:   ${checks.filter((c) => c.pass).length}/${checks.length}`);
  if (criticalFails > 0) console.log(`  ${RED}Critical failures: ${criticalFails}${RESET}`);
  if (warnings > 0) console.log(`  ${YELLOW}Warnings: ${warnings}${RESET}`);

  if (criticalFails === 0) {
    console.log(`\n  ${GREEN}${BOLD}All critical checks passed — ready to launch!${RESET}`);
    console.log(`  Run: ${CYAN}npm run agent${RESET}\n`);
  } else {
    console.log(`\n  ${RED}${BOLD}Fix ${criticalFails} critical issue(s) before launching.${RESET}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Preflight failed: ${err.message}`);
  process.exit(1);
});
