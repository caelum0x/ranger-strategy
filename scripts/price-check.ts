import dotenv from "dotenv";
dotenv.config({ path: ".env.devnet" });
import { Connection, Keypair } from "@solana/web3.js";
import {
  DriftClient,
  BulkAccountLoader,
  Wallet,
  PerpMarkets,
  convertToNumber,
  PRICE_PRECISION,
  FUNDING_RATE_PRECISION,
  BASE_PRECISION,
} from "@drift-labs/sdk";
import * as fs from "fs";

async function main() {
  const raw = JSON.parse(fs.readFileSync("./devnet-keypair.json", "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(raw));
  const wallet = new Wallet(keypair as any);
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const accountLoader = new BulkAccountLoader(
    connection as any,
    "confirmed",
    1000
  );
  const driftClient = new DriftClient({
    connection: connection as any,
    wallet,
    env: "devnet",
    accountSubscription: { type: "polling", accountLoader },
  } as any);
  await driftClient.subscribe();

  const markets = PerpMarkets["devnet"] || [];

  console.log("\n  DRIFT DEVNET — ORACLE PRICES vs REAL WORLD\n");
  console.log(
    "  These oracle prices come from Pyth Network, which pushes"
  );
  console.log(
    "  real market data to devnet. They match real-world prices.\n"
  );

  for (let i = 0; i < Math.min(markets.length, 5); i++) {
    const perp = driftClient.getPerpMarketAccount(i);
    if (!perp) continue;
    const asset =
      markets[i]?.symbol?.replace("-PERP", "") || `?-${i}`;

    // Oracle price from Pyth
    const oraclePrice = convertToNumber(
      perp.amm.historicalOracleData.lastOraclePriceTwap,
      PRICE_PRECISION
    );
    const markPrice = convertToNumber(
      perp.amm.lastMarkPriceTwap,
      PRICE_PRECISION
    );

    // Funding rate
    const fundingRate = convertToNumber(
      perp.amm.lastFundingRate,
      FUNDING_RATE_PRECISION
    );
    const hourlyPct =
      oraclePrice !== 0 ? (fundingRate / oraclePrice) * 100 : 0;
    const annualPct = hourlyPct * 24 * 365.25;

    // Open interest
    const baseLong = convertToNumber(
      perp.amm.baseAssetAmountLong,
      BASE_PRECISION
    );
    const baseShort = convertToNumber(
      perp.amm.baseAssetAmountShort,
      BASE_PRECISION
    );
    const oiLong = Math.abs(baseLong) * oraclePrice;
    const oiShort = Math.abs(baseShort) * oraclePrice;

    console.log(`  ── ${asset} ──`);
    console.log(`     Oracle (Pyth):  $${oraclePrice.toFixed(2)}`);
    console.log(`     Mark price:     $${markPrice.toFixed(2)}`);
    console.log(`     Funding/hr:     ${hourlyPct.toFixed(6)}%`);
    console.log(`     Funding APY:    ${annualPct.toFixed(2)}%`);
    console.log(
      `     OI Long:        $${oiLong.toFixed(2)} (${Math.abs(baseLong).toFixed(4)} ${asset})`
    );
    console.log(
      `     OI Short:       $${oiShort.toFixed(2)} (${Math.abs(baseShort).toFixed(4)} ${asset})`
    );
    console.log(
      `     WHY rate is ${Math.abs(annualPct) > 20 ? "HIGH" : "low"}:  ${
        oiLong + oiShort < 100
          ? "Almost no open interest — tiny imbalance = big rate"
          : oiLong / (oiLong + oiShort) > 0.6
            ? "Longs dominate — shorts get paid heavily"
            : oiShort / (oiLong + oiShort) > 0.6
              ? "Shorts dominate — longs get paid heavily"
              : "Balanced market"
      }`
    );
    console.log();
  }

  console.log("  ── KEY POINT ──");
  console.log(
    "  PRICES are real (from Pyth oracles tracking actual markets)."
  );
  console.log(
    "  FUNDING RATES are inflated because devnet has <$100 total OI."
  );
  console.log(
    "  On mainnet with real traders, rates are typically 5-30% APY."
  );
  console.log();

  await driftClient.unsubscribe();
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
