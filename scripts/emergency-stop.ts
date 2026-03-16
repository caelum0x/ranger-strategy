/**
 * Emergency stop — cancel all orders, close all perp AND spot positions.
 *
 * Use this when the agent is down and you need to manually unwind
 * all positions on Drift before they get liquidated.
 * For delta-neutral strategies, this closes both the perp and spot legs
 * to avoid directional exposure.
 *
 * Usage:
 *   npx ts-node scripts/emergency-stop.ts              # mainnet
 *   npx ts-node scripts/emergency-stop.ts --devnet      # devnet
 *   npx ts-node scripts/emergency-stop.ts --dry-run     # show what would happen
 */
import dotenv from "dotenv";

const isDevnet = process.argv.includes("--devnet");
const isDryRun = process.argv.includes("--dry-run");
dotenv.config({ path: isDevnet ? ".env.devnet" : ".env.mainnet" });

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  convertToNumber,
  PRICE_PRECISION,
  BASE_PRECISION,
  PositionDirection,
  OrderType,
  MarketType,
  SpotBalanceType,
  isVariant,
  getTokenAmount,
  QUOTE_SPOT_MARKET_INDEX,
} from "@drift-labs/sdk";
import * as fs from "fs";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

async function main() {
  const env = isDevnet ? "devnet" : "mainnet-beta";
  console.log(`\n${BOLD}${RED}╔════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${RED}║  RANGER — EMERGENCY STOP (${env.toUpperCase()})${" ".repeat(Math.max(0, 15 - env.length))}║${RESET}`);
  console.log(`${BOLD}${RED}╚════════════════════════════════════════════════╝${RESET}\n`);

  if (isDryRun) {
    console.log(`${YELLOW}DRY RUN — no transactions will be sent${RESET}\n`);
  }

  // Load keypair
  const keypairPath = process.env.ANCHOR_WALLET;
  if (!keypairPath) {
    console.error(`${RED}ANCHOR_WALLET not set${RESET}`);
    process.exit(1);
  }

  let keypair: Keypair;
  try {
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    keypair = Keypair.fromSecretKey(new Uint8Array(raw));
  } catch (err: any) {
    console.error(`${RED}Failed to load keypair: ${err.message}${RESET}`);
    process.exit(1);
  }

  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Connect to RPC
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL;
  if (!rpcUrl) {
    console.error(`${RED}No RPC URL configured${RESET}`);
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);

  // Initialize Drift client
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 1000);
  const driftClient = new DriftClient({
    connection,
    wallet,
    env,
    accountSubscription: { type: "polling", accountLoader },
  });

  await driftClient.subscribe();
  console.log(`${GREEN}Drift client connected${RESET}\n`);

  // Check if we're operating as a vault delegate
  const vaultPubkey = process.env.DRIFT_VAULT_PUBKEY;
  if (vaultPubkey) {
    console.log(`${CYAN}Vault mode: ${vaultPubkey}${RESET}`);
  }

  // 1. Cancel all open orders
  console.log(`${BOLD}Step 1: Cancelling all open orders...${RESET}`);
  const user = driftClient.getUser();
  const openOrders = user.getOpenOrders();
  console.log(`  Found ${openOrders.length} open orders`);

  if (openOrders.length > 0 && !isDryRun) {
    try {
      await driftClient.cancelAllOrders();
      console.log(`  ${GREEN}All orders cancelled${RESET}`);
    } catch (err: any) {
      console.error(`  ${RED}Failed to cancel orders: ${err.message}${RESET}`);
    }
  }

  // 2. Close all perp positions
  console.log(`\n${BOLD}Step 2: Closing all perp positions...${RESET}`);
  const perpPositions = user.getActivePerpPositions();
  console.log(`  Found ${perpPositions.length} active perp positions`);

  for (const pos of perpPositions) {
    const baseAmount = convertToNumber(pos.baseAssetAmount, BASE_PRECISION);
    const isLong = pos.baseAssetAmount.gt(pos.baseAssetAmount.mul(-1).add(pos.baseAssetAmount)); // baseAssetAmount > 0
    const direction = baseAmount > 0 ? "LONG" : "SHORT";
    const absAmount = Math.abs(baseAmount);

    console.log(`  ${pos.marketIndex}: ${direction} ${absAmount.toFixed(4)} base`);

    if (!isDryRun) {
      try {
        const closeSide = baseAmount > 0
          ? PositionDirection.SHORT
          : PositionDirection.LONG;

        await driftClient.placePerpOrder({
          marketIndex: pos.marketIndex,
          orderType: OrderType.MARKET,
          direction: closeSide,
          baseAssetAmount: pos.baseAssetAmount.abs(),
          marketType: MarketType.PERP,
        });
        console.log(`  ${GREEN}Closed perp position for market ${pos.marketIndex}${RESET}`);
      } catch (err: any) {
        console.error(`  ${RED}Failed to close market ${pos.marketIndex}: ${err.message}${RESET}`);
      }
    }
  }

  // 2.5. Close all spot positions (non-USDC)
  console.log(`\n${BOLD}Step 2.5: Closing all spot positions...${RESET}`);
  const spotPositions = user.getActiveSpotPositions();
  const nonUsdcSpotPositions = spotPositions.filter(
    (pos) => pos.marketIndex > 0
  );
  console.log(`  Found ${nonUsdcSpotPositions.length} non-USDC spot positions`);

  for (const pos of nonUsdcSpotPositions) {
    const spotMarket = driftClient.getSpotMarketAccount(pos.marketIndex);
    const tokenAmount = getTokenAmount(
      pos.scaledBalance,
      spotMarket,
      pos.balanceType
    );
    const isDeposit = isVariant(pos.balanceType, "deposit");
    const balanceLabel = isDeposit ? "DEPOSIT" : "BORROW";
    const precision = new (await import("@drift-labs/sdk")).BN(
      10 ** spotMarket.decimals
    );
    const humanAmount = convertToNumber(tokenAmount, precision);

    console.log(
      `  Market ${pos.marketIndex}: ${balanceLabel} ${humanAmount.toFixed(6)} tokens`
    );

    if (!isDryRun) {
      try {
        if (isDeposit) {
          // Deposit (positive balance) — sell to convert back to USDC
          await driftClient.placeSpotOrder({
            orderType: OrderType.MARKET,
            marketType: MarketType.SPOT,
            marketIndex: pos.marketIndex,
            direction: PositionDirection.SHORT,
            baseAssetAmount: tokenAmount,
          });
          console.log(
            `  ${GREEN}Placed market sell for spot market ${pos.marketIndex}${RESET}`
          );
        } else {
          // Borrow (negative balance) — buy to repay the borrow
          await driftClient.placeSpotOrder({
            orderType: OrderType.MARKET,
            marketType: MarketType.SPOT,
            marketIndex: pos.marketIndex,
            direction: PositionDirection.LONG,
            baseAssetAmount: tokenAmount,
          });
          console.log(
            `  ${GREEN}Placed market buy to repay borrow for spot market ${pos.marketIndex}${RESET}`
          );
        }
      } catch (err: any) {
        console.error(
          `  ${RED}Failed to close spot market ${pos.marketIndex}: ${err.message}${RESET}`
        );
      }
    }
  }

  // 3. Settle PnL
  console.log(`\n${BOLD}Step 3: Settling PnL...${RESET}`);
  if (!isDryRun) {
    for (const pos of perpPositions) {
      try {
        await driftClient.settlePNL(
          user.userAccountPublicKey,
          user.getUserAccount(),
          pos.marketIndex
        );
        console.log(`  ${GREEN}PnL settled for market ${pos.marketIndex}${RESET}`);
      } catch (err: any) {
        // Non-critical — PnL may already be settled
        console.log(`  ${YELLOW}PnL settle skipped for market ${pos.marketIndex}: ${err.message}${RESET}`);
      }
    }
  }

  // 3.5. Withdraw remaining USDC deposits to free collateral
  console.log(`\n${BOLD}Step 3.5: Checking USDC spot deposits...${RESET}`);
  if (!isDryRun) {
    try {
      const usdcSpotPosition = user.getSpotPosition(QUOTE_SPOT_MARKET_INDEX);
      if (
        usdcSpotPosition &&
        isVariant(usdcSpotPosition.balanceType, "deposit") &&
        !usdcSpotPosition.scaledBalance.isZero()
      ) {
        const usdcSpotMarket = driftClient.getSpotMarketAccount(
          QUOTE_SPOT_MARKET_INDEX
        );
        const usdcTokenAmount = getTokenAmount(
          usdcSpotPosition.scaledBalance,
          usdcSpotMarket,
          usdcSpotPosition.balanceType
        );
        const usdcPrecision = new (await import("@drift-labs/sdk")).BN(1e6);
        const humanUsdc = convertToNumber(usdcTokenAmount, usdcPrecision);
        console.log(`  USDC deposit balance: $${humanUsdc.toFixed(2)}`);

        // Withdraw to wallet's associated token account
        await driftClient.withdraw(
          usdcTokenAmount,
          QUOTE_SPOT_MARKET_INDEX,
          wallet.publicKey,
          true // reduceOnly — only withdraw what's deposited
        );
        console.log(`  ${GREEN}Withdrew $${humanUsdc.toFixed(2)} USDC to wallet${RESET}`);
      } else {
        console.log(`  ${YELLOW}No USDC deposits to withdraw${RESET}`);
      }
    } catch (err: any) {
      console.log(
        `  ${YELLOW}USDC withdrawal skipped: ${err.message}${RESET}`
      );
    }
  }

  // 4. Show final state
  console.log(`\n${BOLD}Step 4: Final state${RESET}`);
  const freeCollateral = convertToNumber(
    user.getFreeCollateral(),
    new (await import("@drift-labs/sdk")).BN(1e6)
  );
  const totalCollateral = convertToNumber(
    user.getTotalCollateral(),
    new (await import("@drift-labs/sdk")).BN(1e6)
  );
  const remainingOrders = user.getOpenOrders().length;
  const remainingPerps = user.getActivePerpPositions().length;
  const remainingSpots = user.getActiveSpotPositions().filter(
    (pos) => pos.marketIndex > 0
  ).length;

  console.log(`  Free collateral: $${freeCollateral.toFixed(2)}`);
  console.log(`  Total collateral: $${totalCollateral.toFixed(2)}`);
  console.log(`  Remaining orders: ${remainingOrders}`);
  console.log(`  Remaining perps: ${remainingPerps}`);
  console.log(`  Remaining non-USDC spots: ${remainingSpots}`);

  if (remainingOrders === 0 && remainingPerps === 0 && remainingSpots === 0) {
    console.log(`\n${GREEN}${BOLD}Emergency stop complete — all positions closed${RESET}\n`);
  } else {
    console.log(`\n${YELLOW}${BOLD}Some positions may still be open — check manually${RESET}\n`);
  }

  await driftClient.unsubscribe();
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
