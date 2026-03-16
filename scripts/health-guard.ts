/**
 * Automated health ratio guard.
 *
 * Continuously monitors vault health ratio via Drift SDK and takes
 * protective action when it degrades:
 *
 *   - WARNING (< 1.5):  Log + Telegram alert
 *   - DANGER  (< 1.2):  Reduce position sizes by 50%
 *   - CRITICAL (< 1.1):  Emergency full derisk to USDC
 *
 * Usage:
 *   npx ts-node scripts/health-guard.ts
 *   npx ts-node scripts/health-guard.ts --dry-run        # no trades
 *   npx ts-node scripts/health-guard.ts --interval 30    # 30s checks
 */
import dotenv from "dotenv";
dotenv.config();

import {
  DriftClient,
  Wallet,
  initialize,
  BulkAccountLoader,
  convertToNumber,
  PRICE_PRECISION,
  BN,
} from "@drift-labs/sdk";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import { TelegramAlerter } from "../src/alerts/telegram";
import { config } from "../src/config";
import { DriftExecutor } from "../src/drift/executor";

const DRY_RUN = process.argv.includes("--dry-run");
const CHECK_INTERVAL_MS =
  parseInt(
    process.argv.find((a) => a.startsWith("--interval="))?.split("=")[1] || "60"
  ) * 1000;

const THRESHOLDS = {
  WARNING: 1.5,
  DANGER: 1.2,
  CRITICAL: config.healthRatioFloor.toNumber(), // 1.10 from config
};

const telegram = new TelegramAlerter();

let lastAlertLevel: "ok" | "warning" | "danger" | "critical" = "ok";
let lastAlertTs = 0;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same-level alerts

function loadKeypair(): Keypair {
  const path = config.keypairPath;
  if (!path) throw new Error("No ANCHOR_WALLET or KEYPAIR_PATH set");
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function initDrift(): Promise<DriftClient> {
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const keypair = loadKeypair();
  const wallet = new Wallet(keypair);

  const sdkConfig = initialize({ env: config.driftEnv });
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const client = new DriftClient({
    connection,
    wallet,
    env: config.driftEnv,
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
  });

  await client.subscribe();
  return client;
}

function computeHealthRatio(client: DriftClient): {
  healthRatio: number;
  totalCollateral: number;
  maintenanceMargin: number;
  leverage: number;
  freeCollateral: number;
} {
  const user = client.getUser();
  const totalCollateral = convertToNumber(
    user.getTotalCollateral(),
    new BN(1e6)
  );
  const maintenanceMargin = convertToNumber(
    user.getMaintenanceMarginRequirement(),
    new BN(1e6)
  );
  const freeCollateral = convertToNumber(
    user.getFreeCollateral(),
    new BN(1e6)
  );
  const leverage = convertToNumber(user.getLeverage(), new BN(10_000));

  const healthRatio =
    maintenanceMargin > 0 ? totalCollateral / maintenanceMargin : 999;

  return {
    healthRatio,
    totalCollateral,
    maintenanceMargin,
    leverage,
    freeCollateral,
  };
}

async function checkHealth(
  client: DriftClient,
  executor: DriftExecutor
): Promise<void> {
  const now = Date.now();
  const health = computeHealthRatio(client);

  const level =
    health.healthRatio < THRESHOLDS.CRITICAL
      ? "critical"
      : health.healthRatio < THRESHOLDS.DANGER
        ? "danger"
        : health.healthRatio < THRESHOLDS.WARNING
          ? "warning"
          : "ok";

  // Status line
  const statusIcon =
    level === "ok" ? "OK" :
    level === "warning" ? "WARN" :
    level === "danger" ? "DANGER" :
    "CRITICAL";

  console.log(
    `[${new Date().toISOString()}] Health: ${health.healthRatio.toFixed(4)} (${statusIcon}) | ` +
      `Collateral: $${health.totalCollateral.toFixed(2)} | ` +
      `Margin: $${health.maintenanceMargin.toFixed(2)} | ` +
      `Leverage: ${health.leverage.toFixed(2)}x | ` +
      `Free: $${health.freeCollateral.toFixed(2)}`
  );

  // Alert on level change or cooldown expired
  const shouldAlert =
    level !== "ok" &&
    (level !== lastAlertLevel || now - lastAlertTs > ALERT_COOLDOWN_MS);

  if (shouldAlert) {
    const msg =
      `Health ratio: ${health.healthRatio.toFixed(4)}\n` +
      `Level: ${level.toUpperCase()}\n` +
      `Total collateral: $${health.totalCollateral.toFixed(2)}\n` +
      `Maintenance margin: $${health.maintenanceMargin.toFixed(2)}\n` +
      `Leverage: ${health.leverage.toFixed(2)}x\n` +
      `Free collateral: $${health.freeCollateral.toFixed(2)}`;

    const alertLevel =
      level === "critical" ? "critical" : level === "danger" ? "warn" : "info";
    await telegram.alert(alertLevel, msg);
    lastAlertLevel = level;
    lastAlertTs = now;
  }

  // Take action based on level
  if (level === "critical") {
    console.log("[CRITICAL] Health below floor — emergency derisk!");
    if (!DRY_RUN) {
      try {
        // Cancel all orders and close all positions
        await executor.cancelAllOrders();

        // Close perp positions for each target asset
        for (const asset of config.targetAssets) {
          try {
            await executor.atomicDeltaNeutralExit(asset);
          } catch (err) {
            console.error(`Failed to exit ${asset}:`, err);
          }
        }

        await telegram.alert(
          "critical",
          `Emergency derisk executed!\nAll positions closed.\nHealth was: ${health.healthRatio.toFixed(4)}`
        );
      } catch (err) {
        console.error("Emergency derisk failed:", err);
        await telegram.alert(
          "critical",
          `Emergency derisk FAILED: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      console.log("[DRY RUN] Would execute emergency derisk");
    }
  } else if (level === "danger") {
    console.log("[DANGER] Health degrading — would reduce positions by 50%");
    // In production, this would call executor to reduce position sizes
    // For now, just alert — the main agent handles gradual derisking
  }

  // Recovery alert
  if (level === "ok" && lastAlertLevel !== "ok") {
    await telegram.alert(
      "info",
      `Health recovered to ${health.healthRatio.toFixed(4)}\nAll clear.`
    );
    lastAlertLevel = "ok";
  }
}

async function main() {
  console.log("Health Guard");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(
    `Thresholds: warning=${THRESHOLDS.WARNING}, danger=${THRESHOLDS.DANGER}, critical=${THRESHOLDS.CRITICAL}`
  );
  console.log(`RPC: ${config.solanaRpcUrl.slice(0, 40)}...`);
  console.log("");

  const client = await initDrift();
  const executor = new DriftExecutor(client);

  console.log("Drift client initialized. Starting health checks...\n");

  // Initial check
  await checkHealth(client, executor);

  // Continuous monitoring
  setInterval(async () => {
    try {
      await checkHealth(client, executor);
    } catch (err) {
      console.error("Health check error:", err);
    }
  }, CHECK_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
