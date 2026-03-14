/**
 * Devnet setup — creates wallet, airdrops SOL, initializes Drift account.
 *
 * Usage: npx ts-node scripts/devnet-setup.ts
 *
 * This script:
 * 1. Generates a devnet keypair (or loads existing one)
 * 2. Airdrops SOL for transaction fees
 * 3. Initializes a Drift user account on devnet
 * 4. Prints account status
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.devnet" });

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  DriftClient,
  BulkAccountLoader,
  Wallet,
  initialize,
} from "@drift-labs/sdk";
import * as fs from "fs";

const KEYPAIR_PATH = "./devnet-keypair.json";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function log(emoji: string, msg: string) {
  console.log(`  ${emoji} ${msg}`);
}

async function main() {
  console.log(
    `\n${BOLD}═══ Devnet Setup — Ranger Delta-Neutral Agent ═══${RESET}\n`
  );

  // ── Step 1: Keypair ──────────────────────────────────────────
  console.log(`${BOLD}Step 1: Wallet${RESET}`);
  let keypair: Keypair;

  if (fs.existsSync(KEYPAIR_PATH)) {
    const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
    keypair = Keypair.fromSecretKey(new Uint8Array(raw));
    log(GREEN + "✓" + RESET, `Loaded existing keypair: ${keypair.publicKey.toBase58()}`);
  } else {
    keypair = Keypair.generate();
    fs.writeFileSync(
      KEYPAIR_PATH,
      JSON.stringify(Array.from(keypair.secretKey))
    );
    log(GREEN + "✓" + RESET, `Generated new keypair: ${keypair.publicKey.toBase58()}`);
    log(YELLOW + "!" + RESET, `Saved to ${KEYPAIR_PATH}`);
  }

  const wallet = new Wallet(keypair as any);
  const connection = new Connection(RPC_URL, "confirmed");

  // ── Step 2: Airdrop SOL ──────────────────────────────────────
  console.log(`\n${BOLD}Step 2: SOL Airdrop${RESET}`);

  let balance = await connection.getBalance(keypair.publicKey);
  const solBalance = balance / LAMPORTS_PER_SOL;

  if (solBalance < 0.5) {
    log(YELLOW + "!" + RESET, `Current balance: ${solBalance.toFixed(4)} SOL — requesting airdrop...`);
    try {
      // Airdrop 1 SOL (devnet limit per request)
      const sig = await connection.requestAirdrop(
        keypair.publicKey,
        1 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
      balance = await connection.getBalance(keypair.publicKey);
      log(GREEN + "✓" + RESET, `Airdrop received! Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (err: any) {
      log(RED + "✗" + RESET, `Airdrop failed: ${err.message}`);
      log(YELLOW + "!" + RESET, "Try again in a minute (devnet rate limit) or use:");
      log(YELLOW + "!" + RESET, `  solana airdrop 1 ${keypair.publicKey.toBase58()} --url devnet`);
    }
  } else {
    log(GREEN + "✓" + RESET, `SOL balance sufficient: ${solBalance.toFixed(4)} SOL`);
  }

  // ── Step 3: Initialize Drift Account ─────────────────────────
  console.log(`\n${BOLD}Step 3: Drift Account${RESET}`);

  try {
    const accountLoader = new BulkAccountLoader(
      connection as any,
      "confirmed",
      1000
    );

    const driftClient = new DriftClient({
      connection: connection as any,
      wallet,
      env: "devnet",
      accountSubscription: {
        type: "polling",
        accountLoader,
      },
    } as any);

    await driftClient.subscribe();
    log(GREEN + "✓" + RESET, "Connected to Drift devnet");

    const hasUser = await driftClient.hasUser();

    if (hasUser) {
      log(GREEN + "✓" + RESET, "Drift user account already exists");

      const user = driftClient.getUser();
      const collateral = user.getTotalCollateral();
      const freeCollateral = user.getFreeCollateral();
      const collateralUsd = Number(collateral.toString()) / 1e6;
      const freeCollateralUsd = Number(freeCollateral.toString()) / 1e6;

      console.log(`     Total collateral: $${collateralUsd.toFixed(2)}`);
      console.log(`     Free collateral:  $${freeCollateralUsd.toFixed(2)}`);

      const positions = user.getActivePerpPositions();
      console.log(`     Active positions: ${positions.length}`);

      const orders = user.getOpenOrders();
      console.log(`     Open orders:      ${orders.length}`);
    } else {
      log(YELLOW + "!" + RESET, "No Drift account found — initializing...");
      try {
        const [txSig] = await driftClient.initializeUserAccount();
        log(GREEN + "✓" + RESET, `Drift user account created! Tx: ${txSig}`);
      } catch (err: any) {
        log(RED + "✗" + RESET, `Failed to create Drift account: ${err.message}`);
        log(YELLOW + "!" + RESET, "You may need more SOL. Try airdropping again.");
      }
    }

    await driftClient.unsubscribe();
  } catch (err: any) {
    log(RED + "✗" + RESET, `Drift connection failed: ${err.message}`);
  }

  // ── Step 4: Summary ──────────────────────────────────────────
  console.log(`\n${BOLD}═══ Devnet Setup Complete ═══${RESET}`);
  console.log();
  console.log(`  Wallet:  ${keypair.publicKey.toBase58()}`);
  console.log(`  Network: Solana Devnet`);
  console.log(`  RPC:     ${RPC_URL}`);
  console.log();
  console.log(`  ${BOLD}Next steps:${RESET}`);
  console.log(`  1. Get devnet USDC: visit https://faucet.circle.com (select Solana devnet)`);
  console.log(`     or use Drift devnet UI to deposit test USDC`);
  console.log(`  2. Run dry run:    npm run devnet:dry-run`);
  console.log(`  3. Check status:   DRIFT_ENV=devnet ANCHOR_WALLET=./devnet-keypair.json npm run preflight`);
  console.log();
}

main().catch((err) => {
  console.error(`\n${RED}Setup failed:${RESET}`, err.message);
  process.exit(1);
});
