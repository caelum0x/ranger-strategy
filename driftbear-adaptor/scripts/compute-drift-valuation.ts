import "dotenv/config";
import {
  DriftClient,
  Wallet,
  getUserAccountPublicKeySync,
  getTokenAmount,
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

  if (!rpcUrl || !walletPath) {
    throw new Error(
      "Set HELIUS_RPC_URL or SOLANA_RPC_URL and ANCHOR_WALLET or KEYPAIR_PATH"
    );
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(loadKeypairFromFile(walletPath) as any);
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: "mainnet-beta",
    accountSubscription: { type: "cached" },
    subAccountIds: [subAccountId],
    activeSubAccountId: subAccountId,
  } as any);

  await driftClient.subscribe();

  const user = driftClient.getUser(subAccountId);
  const userAccountPubkey = getUserAccountPublicKeySync(
    driftProgramId,
    wallet.publicKey,
    subAccountId
  );
  const spotMarket = driftClient.getSpotMarketAccount(marketIndex);
  const spotPosition = user.getSpotPosition(marketIndex);

  if (!spotMarket || !spotPosition) {
    throw new Error(`No spot position found for market ${marketIndex}`);
  }

  const tokenAmount = getTokenAmount(
    spotPosition.scaledBalance,
    spotMarket,
    spotPosition.balanceType
  );

  const oraclePrice = driftClient.getOracleDataForSpotMarket(marketIndex).price;
  const decimals = spotMarket.decimals;
  const pricePrecision = 1_000_000;
  const tokenPrecision = 10 ** decimals;
  const valueInQuote = tokenAmount
    .mul(oraclePrice)
    .divn(tokenPrecision)
    .toString();

  console.log(
    JSON.stringify(
      {
        userAccount: userAccountPubkey.toBase58(),
        marketIndex,
        subAccountId,
        scaledBalance: spotPosition.scaledBalance.toString(),
        balanceType: Object.keys(spotPosition.balanceType)[0],
        tokenAmount: tokenAmount.toString(),
        oraclePrice: oraclePrice.toString(),
        valueInQuotePrecision: valueInQuote,
        valueUi: Number(valueInQuote) / pricePrecision,
      },
      null,
      2
    )
  );

  await driftClient.unsubscribe();
}

function loadKeypairFromFile(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
