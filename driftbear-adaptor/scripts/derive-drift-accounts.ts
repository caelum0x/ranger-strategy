import "dotenv/config";
import {
  DriftClient,
  Wallet,
  getDriftStateAccountPublicKey,
  getUserAccountPublicKeySync,
  getUserStatsAccountPublicKey,
  DRIFT_PROGRAM_ID,
} from "@drift-labs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";

const driftProgramId = new PublicKey(DRIFT_PROGRAM_ID);

async function main(): Promise<void> {
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
  const walletPath = process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH;
  const marketIndex = parseInt(process.env.DRIFT_MARKET_INDEX || "0", 10);
  const subAccountId = parseInt(process.env.DRIFT_SUBACCOUNT_ID || "0", 10);
  const strategy = process.env.STRATEGY_PUBKEY;

  if (!rpcUrl || !walletPath || !strategy) {
    throw new Error(
      "Set HELIUS_RPC_URL or SOLANA_RPC_URL, ANCHOR_WALLET or KEYPAIR_PATH, and STRATEGY_PUBKEY"
    );
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const keypair = loadKeypairFromFile(walletPath);
  const wallet = new Wallet(keypair as any);
  const state = await getDriftStateAccountPublicKey(driftProgramId);
  const user = getUserAccountPublicKeySync(
    driftProgramId,
    wallet.publicKey,
    subAccountId
  );
  const userStats = getUserStatsAccountPublicKey(
    driftProgramId,
    wallet.publicKey
  );
  const [spotMarketVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new anchor.BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    driftProgramId
  );
  const [spotMarket] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market"),
      new anchor.BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    driftProgramId
  );

  const driftClient = new DriftClient({
    connection,
    wallet,
    env: "mainnet-beta",
    accountSubscription: {
      type: "cached",
    },
  } as any);
  await driftClient.subscribe();
  const stateAccount = driftClient.getStateAccount();
  const driftSigner = stateAccount.signer;
  await driftClient.unsubscribe();

  console.log(
    JSON.stringify(
      {
        strategy,
        marketIndex,
        subAccountId,
        orderedAccounts: {
          initialize: [strategy, "position PDA", state.toBase58(), user.toBase58(), userStats.toBase58(), driftProgramId.toBase58()],
          deposit: [
            wallet.publicKey.toBase58(),
            strategy,
            "vault asset mint",
            "strategy token ata",
            "token program",
            "position PDA",
            state.toBase58(),
            user.toBase58(),
            userStats.toBase58(),
            spotMarket.toBase58(),
            spotMarketVault.toBase58(),
            driftProgramId.toBase58(),
          ],
          withdraw: [
            wallet.publicKey.toBase58(),
            strategy,
            "vault asset mint",
            "strategy token ata",
            "token program",
            "position PDA",
            state.toBase58(),
            user.toBase58(),
            userStats.toBase58(),
            spotMarket.toBase58(),
            spotMarketVault.toBase58(),
            driftSigner.toBase58(),
            driftProgramId.toBase58(),
          ],
        },
      },
      null,
      2
    )
  );
}

function loadKeypairFromFile(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

// Anchor is only used here to encode the u16 seed exactly like Drift.
const anchor = require("@coral-xyz/anchor");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
