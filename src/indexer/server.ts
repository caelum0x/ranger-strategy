import http from "http";
import { URL } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { IndexerStore } from "./db";
import { IndexerDecisionEngine } from "./ai-decision";
import { VoltrVaultParser } from "./voltr-parser";

interface HeliusEvent {
  account?: string | { pubkey?: string };
  accountData?: { account?: string };
  accounts?: string[];
  signature?: string;
  slot?: number;
  type?: string;
}

function normalizeVaultAccountAddress(event: HeliusEvent): string | undefined {
  if (typeof event.account === "string") return event.account;
  if (event.account?.pubkey) return event.account.pubkey;
  if (event.accountData?.account) return event.accountData.account;
  if (Array.isArray(event.accounts) && event.accounts.length > 0) {
    return event.accounts[0];
  }
  return undefined;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<void> {
  if (!config.vaultPubkey) {
    throw new Error("VAULT_PUBKEY must be set before starting the indexer");
  }

  const store = new IndexerStore();
  const parser = new VoltrVaultParser();
  const decisionEngine = new IndexerDecisionEngine(store);
  const vaultPubkey = new PublicKey(config.vaultPubkey);

  const indexVault = async (sourceEvent: {
    type: string;
    signature?: string;
    slot?: number;
  }) => {
    const snapshot = await parser.parseVaultState(config.vaultPubkey, sourceEvent);
    await store.saveSnapshot(snapshot);
    const decision = await decisionEngine.decideRebalance();

    logger.info("Vault indexed", {
      vault: snapshot.vault,
      aum: snapshot.aum,
      source: sourceEvent.type,
      signature: sourceEvent.signature,
      action: decision.action,
    });

    return { snapshot, decision };
  };

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && reqUrl.pathname === "/health") {
        const latest = store.getLatestSnapshot();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            vault: config.vaultPubkey,
            latestSnapshotAt: latest?.timestamp || null,
          })
        );
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/backfill") {
        const result = await indexVault({ type: "manual-backfill" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            vault: result.snapshot.vault,
            aum: result.snapshot.aum,
            action: result.decision.action,
          })
        );
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === config.webhookPath) {
        const payload = await readJsonBody(req);
        const events = Array.isArray(payload) ? payload : [payload];

        let indexed = false;
        for (const event of events as HeliusEvent[]) {
          const account = normalizeVaultAccountAddress(event);
          if (account !== config.vaultPubkey) {
            continue;
          }

          await indexVault({
            type: event.type || "helius-webhook",
            signature: event.signature,
            slot: event.slot,
          });
          indexed = true;
        }

        res.writeHead(indexed ? 200 : 202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, indexed }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    } catch (error: any) {
      logger.error("Indexer server request failed", { error });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error?.message || "internal_error",
        })
      );
    }
  });

  server.listen(config.webhookPort, () => {
    logger.info("Indexer server listening", {
      port: config.webhookPort,
      path: config.webhookPath,
      vault: config.vaultPubkey,
    });
  });

  // Websocket fallback: subscribe directly to vault account changes
  try {
    const wsConnection = new Connection(config.heliusRpcUrl, {
      commitment: "confirmed",
      wsEndpoint: config.heliusWssUrl,
    });
    let lastIndexedSlot = 0;
    let lastIndexedAt = 0;
    const minIntervalMs = 2_000;

    const subscriptionId = wsConnection.onAccountChange(
      vaultPubkey,
      async (_, context) => {
        const now = Date.now();
        if (context.slot <= lastIndexedSlot || now - lastIndexedAt < minIntervalMs) {
          return;
        }
        lastIndexedSlot = context.slot;
        lastIndexedAt = now;
        try {
          await indexVault({ type: "ws-account-change", slot: context.slot });
        } catch (error) {
          logger.warn("WS indexer update failed", { error });
        }
      },
      "confirmed"
    );

    logger.info("Websocket fallback enabled", {
      vault: config.vaultPubkey,
      ws: config.heliusWssUrl,
      subscriptionId,
    });
  } catch (error) {
    logger.warn("Failed to start websocket fallback", { error });
  }
}

main().catch((error) => {
  logger.error("Failed to start indexer server", { error });
  process.exit(1);
});
