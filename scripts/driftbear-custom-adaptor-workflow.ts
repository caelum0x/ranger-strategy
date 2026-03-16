import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import Decimal from "decimal.js";
import { Keypair, PublicKey, Connection, Transaction } from "@solana/web3.js";
import { RangerVaultManager } from "../src/ranger/client";
import { config } from "../src/config";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  DriftClient,
  Wallet as DriftWallet,
  TokenFaucet,
  getDriftSignerPublicKey,
  getDriftStateAccountPublicKey,
  getSpotMarketPublicKey,
  getUserAccountPublicKeySync,
  getUserStatsAccountPublicKey,
} from "@drift-labs/sdk";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  deriveDriftBearPosition,
  deriveDriftBearStrategy,
} from "../src/ranger/driftbear-adaptor";

const FAUCET_PROGRAM_ID = new PublicKey(
  "V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB"
);
const DRIFT_DEVNET_USDC_MINT = new PublicKey(
  "8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2"
);
const POSITION_ACCOUNT_SIZE = 8 + 32 + 2 + 2 + 1 + 8;

function parseArg(flag: string, fallback?: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  return args[index + 1] ?? fallback;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function uiToNative(amount: string, decimals: number): BN {
  const raw = amount.trim();
  if (!raw || raw === "0") {
    return new BN(0);
  }
  const [whole, fraction = ""] = raw.split(".");
  const sanitizedWhole = whole.length ? whole : "0";
  const fracPadded = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = sanitizedWhole + fracPadded;
  const normalized = combined.replace(/^0+/, "") || "0";
  return new BN(normalized);
}

async function ensureAta(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (info) {
    return ata;
  }
  const ix = createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint
  );
  const tx = new Transaction().add(ix);
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  await provider.sendAndConfirm(tx, []);
  return ata;
}

async function shouldUseDirectAdaptorFlow(
  connection: Connection,
  vault: PublicKey
): Promise<boolean> {
  if (process.env.DRIFTBEAR_DIRECT_ADAPTOR === "true") {
    return true;
  }
  const vaultProgram = new PublicKey(config.programs.vaultProgram);
  const vaultProgramInfo = await connection.getAccountInfo(vaultProgram);
  if (!vaultProgramInfo) {
    return true;
  }
  const vaultInfo = await connection.getAccountInfo(vault);
  if (!vaultInfo) {
    return true;
  }
  return !vaultInfo.owner.equals(vaultProgram);
}

async function runDirectAdaptorWorkflow(params: {
  keypair: Keypair;
  vault: PublicKey;
  marketIndex: number;
  subAccountId: number;
  depositAmount: Decimal;
  withdrawAmount: Decimal;
}): Promise<void> {
  const {
    keypair,
    vault,
    marketIndex,
    subAccountId,
    depositAmount,
    withdrawAmount,
  } = params;
  const connection = new Connection(config.heliusRpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(keypair),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const idl = require("../driftbear-adaptor/target/idl/driftbear_custom_adaptor.json");
  const idlWithAddress = {
    ...idl,
    address: config.programs.driftbearCustomAdaptor,
  };
  const adaptorProgram = new anchor.Program(
    idlWithAddress as any,
    provider as any
  ) as any;

  const driftProgramId = new PublicKey(config.programs.drift);
  const driftClient = new DriftClient({
    connection: connection as any,
    wallet: new DriftWallet(keypair as any) as any,
    env: config.driftEnv,
    skipLoadUsers: true,
  });
  await driftClient.subscribe();

  const spotMarket = driftClient.getSpotMarketAccount(marketIndex);
  if (!spotMarket) {
    throw new Error(
      `Spot market ${marketIndex} not found on ${config.driftEnv}`
    );
  }

  const driftUser = getUserAccountPublicKeySync(
    driftProgramId,
    keypair.publicKey,
    subAccountId
  );
  const driftUserStats = getUserStatsAccountPublicKey(
    driftProgramId,
    keypair.publicKey
  );
  console.log(`Drift subaccount: ${subAccountId}`);
  console.log(`Drift user: ${driftUser.toBase58()}`);
  console.log(`Drift user stats: ${driftUserStats.toBase58()}`);
  const driftUserInfo = await connection.getAccountInfo(driftUser);
  if (!driftUserInfo) {
    const [sig] = await driftClient.initializeUserAccount(subAccountId);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const strategy = deriveDriftBearStrategy(
    new PublicKey(config.programs.driftbearCustomAdaptor),
    vault,
    marketIndex
  );
  const position = deriveDriftBearPosition(
    new PublicKey(config.programs.driftbearCustomAdaptor),
    strategy
  );
  const driftState = await getDriftStateAccountPublicKey(driftProgramId);
  const spotMarketPubkey = await getSpotMarketPublicKey(
    driftProgramId,
    marketIndex
  );
  const driftSigner = getDriftSignerPublicKey(driftProgramId);
  const strategyTokenAta = await ensureAta(
    connection,
    keypair.publicKey,
    spotMarket.mint,
    keypair.publicKey
  );

  const depositAmountNative = uiToNative(
    depositAmount.toFixed(spotMarket.decimals),
    spotMarket.decimals
  );
  const withdrawAmountNative = uiToNative(
    withdrawAmount.toFixed(spotMarket.decimals),
    spotMarket.decimals
  );

  const positionInfo = await connection.getAccountInfo(position);
  if (positionInfo) {
    const sig = await adaptorProgram.methods
      .migratePosition()
      .accounts({
        payer: keypair.publicKey,
        authority: keypair.publicKey,
        strategy,
        position,
        driftUser,
        driftUserStats,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log(
      positionInfo.data.length < POSITION_ACCOUNT_SIZE
        ? `Migrated (realloc): ${sig}`
        : `Migrated (sync): ${sig}`
    );
  }

  if (!positionInfo) {
    const sig = await adaptorProgram.methods
      .initialize(marketIndex)
      .accounts({
        payer: keypair.publicKey,
        authority: keypair.publicKey,
        strategy,
        position,
        driftState,
        driftUser,
        driftUserStats,
        driftProgram: driftProgramId,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log(`Initialized: ${sig}`);
  }

  if (depositAmountNative.gt(new BN(0))) {
    let ata = await getAccount(connection, strategyTokenAta);
    let balance = new BN(ata.amount.toString());
    if (
      balance.lt(depositAmountNative) &&
      config.driftEnv === "devnet" &&
      process.env.DRIFTBEAR_FAUCET_TOPUP === "true"
    ) {
      if (!spotMarket.mint.equals(DRIFT_DEVNET_USDC_MINT)) {
        throw new Error(
          "Faucet top-up is only supported for devnet USDC spot market."
        );
      }
      const tokenFaucet = new TokenFaucet(
        connection as any,
        new DriftWallet(keypair as any) as any,
        FAUCET_PROGRAM_ID,
        DRIFT_DEVNET_USDC_MINT
      );
      const topUpAmount = depositAmount;
      const faucetAmount = uiToNative(
        topUpAmount.toFixed(spotMarket.decimals),
        spotMarket.decimals
      );
      await tokenFaucet.mintToUser(strategyTokenAta as any, faucetAmount);
      ata = await getAccount(connection, strategyTokenAta);
      balance = new BN(ata.amount.toString());
    }

    if (balance.lt(depositAmountNative)) {
      throw new Error(
        `Insufficient balance in strategy ATA (${balance.toString()}) for deposit ${depositAmountNative.toString()}.`
      );
    }
  }

  if (depositAmountNative.gt(new BN(0))) {
    const sig = await adaptorProgram.methods
      .deposit(depositAmountNative)
      .accounts({
        strategyAuthority: keypair.publicKey,
        strategy,
        vaultAssetMint: spotMarket.mint,
        strategyTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        position,
        driftState,
        driftUser,
        driftUserStats,
        spotMarket: spotMarketPubkey,
        spotMarketVault: spotMarket.vault,
        spotMarketOracle: spotMarket.oracle,
        driftProgram: driftProgramId,
      })
      .rpc();
    console.log("Deposited (direct):", sig);
  }

  if (withdrawAmountNative.gt(new BN(0))) {
    const sig = await adaptorProgram.methods
      .withdraw(withdrawAmountNative)
      .accounts({
        strategyAuthority: keypair.publicKey,
        strategy,
        vaultAssetMint: spotMarket.mint,
        strategyTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        position,
        driftState,
        driftUser,
        driftUserStats,
        spotMarket: spotMarketPubkey,
        spotMarketVault: spotMarket.vault,
        spotMarketOracle: spotMarket.oracle,
        driftSigner,
        driftProgram: driftProgramId,
      })
      .rpc();
    console.log("Withdrew (direct):", sig);
  }

  await driftClient.unsubscribe();
}

async function main(): Promise<void> {
  const walletPath = process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH;
  const marketIndex = parseInt(process.env.DRIFT_MARKET_INDEX || "0", 10);
  const subAccountId = parseInt(process.env.DRIFT_SUB_ACCOUNT_ID || "0", 10);
  const depositAmount = new Decimal(parseArg("--deposit", "1") || "1");
  const withdrawAmount = new Decimal(parseArg("--withdraw", "0.5") || "0.5");
  const skipInit = hasFlag("--skip-init");
  const skipDeposit = hasFlag("--skip-deposit");
  const skipWithdraw = hasFlag("--skip-withdraw");
  const vaultArg = parseArg("--vault");

  if (!walletPath) {
    throw new Error("Set ANCHOR_WALLET or KEYPAIR_PATH");
  }

  const keypair = loadKeypair(walletPath);
  const vaultPubkey = vaultArg
    ? new PublicKey(vaultArg)
    : config.vaultPubkey
    ? new PublicKey(config.vaultPubkey)
    : null;
  if (!vaultPubkey) {
    throw new Error("Set VAULT_PUBKEY in env or pass --vault");
  }

  const connection = new Connection(config.heliusRpcUrl, "confirmed");
  if (await shouldUseDirectAdaptorFlow(connection, vaultPubkey)) {
    console.log("Using direct adaptor workflow (vault program unavailable)");
    await runDirectAdaptorWorkflow({
      keypair,
      vault: vaultPubkey,
      marketIndex,
      subAccountId,
      depositAmount,
      withdrawAmount,
    });
    return;
  }

  const manager = new RangerVaultManager(keypair.secretKey, keypair.secretKey);
  await manager.initialize();

  (manager as any).vaultPubkey = vaultPubkey;

  console.log("DriftBear custom adaptor workflow");
  console.log(`  Vault: ${vaultPubkey.toBase58()}`);
  console.log(`  Market: ${marketIndex}`);

  if (!skipInit) {
    const initResult = await manager.initializeDriftBearCustomAdaptorStrategy(
      marketIndex
    );
    console.log("Initialized strategy:", initResult.strategyPubkey.toBase58());
    console.log("Init tx:", initResult.txSignature);
  }

  if (!skipDeposit) {
    await manager.depositToDriftBearCustomAdaptorStrategy(
      depositAmount,
      marketIndex
    );
    console.log(`Deposited ${depositAmount.toFixed(6)} to custom adaptor`);
  }

  if (!skipWithdraw) {
    await manager.withdrawFromDriftBearCustomAdaptorStrategy(
      withdrawAmount,
      marketIndex
    );
    console.log(`Withdrew ${withdrawAmount.toFixed(6)} from custom adaptor`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
