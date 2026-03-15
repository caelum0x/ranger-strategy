import "dotenv/config";
import { DriftManager } from "../src/drift/client";
import { DriftExecutor } from "../src/drift/executor";
import { LiquidationService } from "../src/liquidation/service";
import { config } from "../src/config";

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

async function main(): Promise<void> {
  const keypairSource =
    process.env.ANCHOR_WALLET || config.keypairPath || config.solanaPrivateKey;
  if (!keypairSource) {
    throw new Error("Set ANCHOR_WALLET or SOLANA_PRIVATE_KEY");
  }

  const drift = new DriftManager({
    keypair: keypairSource,
    subAccountIds: config.liquidationSubaccounts,
    activeSubAccountId: config.liquidationDefaultSubaccountId,
  });
  await drift.initialize();

  const executor = new DriftExecutor(drift.getClient());
  const liquidator = new LiquidationService(drift.getClient(), executor);
  await liquidator.initialize();

  if (hasFlag("--once")) {
    await liquidator.runOnce();
    await liquidator.shutdown();
    await drift.shutdown();
    return;
  }

  const interval = setInterval(async () => {
    try {
      await liquidator.runOnce();
    } catch (error) {
      console.error("Liquidator tick failed:", error);
    }
  }, config.liquidationScanIntervalMs);

  await liquidator.runOnce();

  const shutdown = async () => {
    clearInterval(interval);
    await liquidator.shutdown();
    await drift.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Liquidator failed:", error);
  process.exit(1);
});
