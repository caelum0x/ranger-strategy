/**
 * Close all devnet positions and orders for a clean state.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.devnet" });

import { Connection, Keypair } from "@solana/web3.js";
import {
  DriftClient,
  BulkAccountLoader,
  Wallet,
  PerpMarkets,
  convertToNumber,
  BASE_PRECISION,
  QUOTE_PRECISION,
  PositionDirection,
  OrderType,
  MarketType,
} from "@drift-labs/sdk";
import * as fs from "fs";

async function main() {
  const raw = JSON.parse(fs.readFileSync("./devnet-keypair.json", "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(raw));
  const wallet = new Wallet(keypair as any);
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const accountLoader = new BulkAccountLoader(connection as any, "confirmed", 1000);
  const driftClient = new DriftClient({
    connection: connection as any,
    wallet,
    env: "devnet",
    accountSubscription: { type: "polling", accountLoader },
  } as any);

  await driftClient.subscribe();
  const user = driftClient.getUser();
  const markets = PerpMarkets["devnet"] || [];

  // Cancel all orders
  const orders = user.getOpenOrders();
  if (orders.length > 0) {
    console.log(`Cancelling ${orders.length} open orders...`);
    await driftClient.cancelOrders();
  }

  // Close all perp positions (skip zero-size)
  const positions = user.getActivePerpPositions();
  for (const pos of positions) {
    if (pos.baseAssetAmount.isZero()) continue;
    const name = markets[pos.marketIndex]?.symbol || `PERP-${pos.marketIndex}`;
    const size = convertToNumber(pos.baseAssetAmount, BASE_PRECISION);
    const direction = size > 0 ? PositionDirection.SHORT : PositionDirection.LONG;

    console.log(`Closing ${name}: ${size > 0 ? "LONG" : "SHORT"} ${Math.abs(size).toFixed(6)}`);
    await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: pos.marketIndex,
      direction,
      baseAssetAmount: pos.baseAssetAmount.abs(),
      reduceOnly: true,
    } as any);
    await new Promise(r => setTimeout(r, 1500));
  }

  // Wait and check
  await new Promise(r => setTimeout(r, 2000));
  const collateral = Number(user.getTotalCollateral().toString()) / 1e6;
  const free = Number(user.getFreeCollateral().toString()) / 1e6;
  const leverage = Number(user.getLeverage().toString()) / 1e4;

  console.log(`\nAccount status:`);
  console.log(`  Collateral: $${collateral.toFixed(2)}`);
  console.log(`  Free:       $${free.toFixed(2)}`);
  console.log(`  Leverage:   ${leverage.toFixed(2)}x`);
  console.log(`  Open orders: ${user.getOpenOrders().length}`);

  // List any remaining positions
  const remaining = user.getActivePerpPositions().filter(p => !p.baseAssetAmount.isZero());
  console.log(`  Active perps: ${remaining.length}`);
  if (remaining.length === 0) {
    console.log(`  ✓ Clean state — ready for strategy test`);
  }

  await driftClient.unsubscribe();
}

main().catch(e => { console.error(e.message); process.exit(1); });
