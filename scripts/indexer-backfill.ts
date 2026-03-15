import "dotenv/config";
import { config } from "../src/config";
import { IndexerDecisionEngine } from "../src/indexer/ai-decision";
import { IndexerStore } from "../src/indexer/db";
import { VoltrVaultParser } from "../src/indexer/voltr-parser";

async function main(): Promise<void> {
  const vault = process.argv[2] || config.vaultPubkey;
  if (!vault) {
    throw new Error("Provide vault pubkey as argv[2] or set VAULT_PUBKEY");
  }

  const store = new IndexerStore();
  const parser = new VoltrVaultParser();
  const decisionEngine = new IndexerDecisionEngine(store);

  const snapshot = await parser.parseVaultState(vault, {
    type: "manual-backfill",
  });
  await store.saveSnapshot(snapshot);
  const decision = await decisionEngine.decideRebalance();

  console.log(
    JSON.stringify(
      {
        ok: true,
        vault: snapshot.vault,
        aum: snapshot.aum,
        action: decision.action,
        confidence: decision.confidence,
        storePath: config.indexerStorePath,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Indexer backfill failed:", error);
  process.exit(1);
});
