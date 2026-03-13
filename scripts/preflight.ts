/**
 * Pre-flight check: validates configuration, wallet, RPC connection,
 * and Drift account readiness before deploying the live agent.
 *
 * Usage: npx ts-node scripts/preflight.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { loadKeypair, DriftClient, BulkAccountLoader, DRIFT_PROGRAM_ID } from "@drift-labs/sdk";
import { Wallet } from "@drift-labs/sdk";
import Decimal from "decimal.js";
import { config } from "../src/config";
import { validateConfig } from "../src/utils/validate";

// ANSI colors for terminal output
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function pass(msg: string) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${YELLOW}!${RESET} ${msg}`);
}

async function main() {
  console.log(`\n${BOLD}═══ Ranger Strategy Agent — Pre-flight Check ═══${RESET}\n`);

  let allPassed = true;

  // ── 1. Config Validation ──────────────────────────────────────────

  console.log(`${BOLD}1. Configuration${RESET}`);
  // Temporarily silence the logger for validation (it logs internally)
  const result = validateConfig();

  if (result.valid) {
    pass("Config is valid");
  } else {
    fail("Config has errors:");
    for (const e of result.errors) {
      console.log(`     ${RED}→${RESET} ${e}`);
    }
    allPassed = false;
  }
  for (const w of result.warnings) {
    warn(w);
  }

  console.log(`  Mode: ${config.strategyMode}`);
  console.log(`  Environment: ${config.driftEnv}`);
  console.log(`  Assets: ${config.targetAssets.join(", ")}`);
  console.log(`  Max leverage: ${config.maxLeverage}x`);
  console.log(`  Health floor: ${config.healthRatioFloor}`);
  console.log(`  Max drawdown: ${config.maxDrawdownPct}%`);

  // ── 2. Wallet ─────────────────────────────────────────────────────

  console.log(`\n${BOLD}2. Wallet${RESET}`);
  let wallet: Wallet | null = null;

  try {
    const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;
    if (typeof keypairSource === "string" && keypairSource.startsWith("/")) {
      const kp = loadKeypair(keypairSource);
      wallet = new Wallet(kp);
    } else if (keypairSource) {
      // Attempt to load from file or parse as bytes
      try {
        const fs = require("fs");
        const bytes = new Uint8Array(JSON.parse(fs.readFileSync(keypairSource, "utf-8")));
        wallet = new Wallet(Keypair.fromSecretKey(bytes));
      } catch {
        fail(`Could not load wallet from: ${keypairSource}`);
        allPassed = false;
      }
    }

    if (wallet) {
      pass(`Wallet loaded: ${wallet.publicKey.toBase58()}`);
    } else {
      fail("No wallet configured");
      allPassed = false;
    }
  } catch (err: any) {
    fail(`Wallet error: ${err.message}`);
    allPassed = false;
  }

  // ── 3. RPC Connection ─────────────────────────────────────────────

  console.log(`\n${BOLD}3. Solana RPC${RESET}`);
  const connection = new Connection(config.solanaRpcUrl, "confirmed");

  try {
    const start = Date.now();
    const slot = await connection.getSlot();
    const latency = Date.now() - start;

    pass(`Connected — slot ${slot} (${latency}ms latency)`);

    if (latency > 2000) {
      warn("RPC latency > 2s — may cause transaction timeouts");
    }

    // Check SOL balance for tx fees
    if (wallet) {
      const solBalance = await connection.getBalance(wallet.publicKey);
      const solAmount = solBalance / 1e9;
      if (solAmount < 0.01) {
        fail(`SOL balance too low: ${solAmount.toFixed(4)} SOL (need ≥0.01 for tx fees)`);
        allPassed = false;
      } else {
        pass(`SOL balance: ${solAmount.toFixed(4)} SOL`);
      }
    }
  } catch (err: any) {
    fail(`RPC connection failed: ${err.message}`);
    allPassed = false;
  }

  // ── 4. Drift Account ──────────────────────────────────────────────

  console.log(`\n${BOLD}4. Drift Account${RESET}`);
  if (wallet) {
    try {
      const accountLoader = new BulkAccountLoader(
        connection as any,
        "confirmed",
        1000
      );

      const driftClient = new DriftClient({
        connection: connection as any,
        wallet,
        env: config.driftEnv,
        accountSubscription: {
          type: "polling",
          accountLoader,
        },
      } as any);

      await driftClient.subscribe();

      const hasUser = await driftClient.hasUser();
      if (hasUser) {
        pass("Drift user account exists");

        const user = driftClient.getUser();
        const collateral = user.getTotalCollateral();
        const freeCollateral = user.getFreeCollateral();
        const leverage = user.getLeverage();

        // Approximate dollar values (QUOTE_PRECISION = 1e6)
        const collateralUsd = Number(collateral.toString()) / 1e6;
        const freeCollateralUsd = Number(freeCollateral.toString()) / 1e6;
        const leverageNum = Number(leverage.toString()) / 1e4;

        console.log(`  Total collateral: $${collateralUsd.toFixed(2)}`);
        console.log(`  Free collateral: $${freeCollateralUsd.toFixed(2)}`);
        console.log(`  Current leverage: ${leverageNum.toFixed(2)}x`);

        if (collateralUsd < 5) {
          warn("Collateral < $5 — minimum recommended for live trading is $10-20 USDC");
        }

        // Check open positions
        const positions = user.getActivePerpPositions();
        console.log(`  Active perp positions: ${positions.length}`);

        // Check open orders
        const orders = user.getOpenOrders();
        console.log(`  Open orders: ${orders.length}`);
      } else {
        warn("No Drift user account — run initializeUser() before trading");
      }

      await driftClient.unsubscribe();
    } catch (err: any) {
      fail(`Drift check failed: ${err.message}`);
      allPassed = false;
    }
  } else {
    warn("Skipping Drift check — no wallet");
  }

  // ── 5. Drift Vault (optional) ──────────────────────────────────────

  console.log(`\n${BOLD}5. Drift Vault${RESET}`);
  const vaultPubkey = process.env.DRIFT_VAULT_PUBKEY;
  if (vaultPubkey) {
    pass(`Vault configured: ${vaultPubkey}`);
  } else {
    warn("No DRIFT_VAULT_PUBKEY set — agent will trade on its own account (not vault delegate)");
  }

  // ── 6. Binance (cross-venue only) ─────────────────────────────────

  console.log(`\n${BOLD}6. Binance${RESET}`);
  if (config.strategyMode === "cross-venue") {
    if (config.binanceApiKey && config.binanceSecret) {
      pass("Binance API credentials configured");
      if (config.binanceTestnet) {
        warn("Using Binance testnet — switch to mainnet for live trading");
      }
    } else {
      fail("cross-venue mode requires Binance API credentials");
      allPassed = false;
    }
  } else {
    pass("Drift-only mode — Binance not required");
  }

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`\n${BOLD}═══ Result ═══${RESET}`);
  if (allPassed) {
    console.log(`\n  ${GREEN}${BOLD}All checks passed — ready to deploy!${RESET}`);
    console.log(`  Run: npm run agent\n`);
  } else {
    console.log(`\n  ${RED}${BOLD}Some checks failed — fix issues above before deploying.${RESET}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${RED}Pre-flight check crashed:${RESET}`, err.message);
  process.exit(1);
});
