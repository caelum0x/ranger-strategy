import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import Decimal from "decimal.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { RangerVaultManager } from "../src/ranger/client";
import { config } from "../src/config";

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

async function main(): Promise<void> {
  const walletPath = process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH;
  const marketIndex = parseInt(process.env.DRIFT_MARKET_INDEX || "0", 10);
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
  const manager = new RangerVaultManager(keypair.secretKey, keypair.secretKey);
  await manager.initialize();

  if (vaultArg) {
    const vaultPubkey = new PublicKey(vaultArg);
    (manager as any).vaultPubkey = vaultPubkey;
  }

  if (!(manager as any).vaultPubkey && !config.vaultPubkey) {
    throw new Error("Set VAULT_PUBKEY in env or pass --vault");
  }

  console.log("DriftBear custom adaptor workflow");
  console.log(`  Vault: ${(manager as any).vaultPubkey?.toBase58() || config.vaultPubkey}`);
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
