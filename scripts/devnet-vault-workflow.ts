/**
 * Real devnet workflow runner for Drift vaults.
 *
 * This executes a real initialize -> deposit -> withdraw cycle against the
 * Drift vaults program on devnet. It is the executable replacement for the
 * earlier mock custom-adaptor test scaffold.
 *
 * Usage:
 *   npx ts-node scripts/devnet-vault-workflow.ts
 *   npx ts-node scripts/devnet-vault-workflow.ts --deposit 10 --withdraw 4
 *   npx ts-node scripts/devnet-vault-workflow.ts --vault <PUBKEY> --skip-init
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.devnet" });

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TokenFaucet } from "@drift-labs/sdk";
import {
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import Decimal from "decimal.js";
import { DriftManager } from "../src/drift/client";
import { DriftVaultManager } from "../src/drift/vault";
import { config } from "../src/config";

const FAUCET_PROGRAM_ID = new PublicKey(
  "V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB"
);
const DRIFT_DEVNET_USDC_MINT = new PublicKey(
  "8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2"
);

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

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

async function ensureWalletUsdcBalance(
  drift: DriftManager,
  requiredUsdc: Decimal
): Promise<void> {
  const driftClient = drift.getClient();
  const wallet = drift.getWallet();
  const walletUsdcAta = getAssociatedTokenAddressSync(
    DRIFT_DEVNET_USDC_MINT,
    wallet.publicKey
  );

  if (!(await driftClient.hasUser())) {
    console.log(`  ${YELLOW}!${RESET} No Drift user account found, initializing...`);
    const [txSig] = await driftClient.initializeUserAccount();
    console.log(`  ${GREEN}✓${RESET} Drift user initialized: ${txSig}`);
  }

  let walletUsdcBalance = new Decimal(0);
  try {
    const walletUsdcAccount = await getAccount(
      driftClient.connection,
      walletUsdcAta
    );
    walletUsdcBalance = new Decimal(walletUsdcAccount.amount.toString()).div(1e6);
  } catch {
    walletUsdcBalance = new Decimal(0);
  }

  if (walletUsdcBalance.gte(requiredUsdc)) {
    console.log(
      `  ${GREEN}✓${RESET} Wallet devnet USDC already sufficient: $${walletUsdcBalance.toFixed(2)}`
    );
    return;
  }

  const shortfall = requiredUsdc.sub(walletUsdcBalance);
  const topUpAmount = Decimal.max(shortfall, new Decimal(5)).toDecimalPlaces(
    6,
    Decimal.ROUND_UP
  );

  console.log(
    `  ${YELLOW}!${RESET} Wallet devnet USDC $${walletUsdcBalance.toFixed(2)} is below required $${requiredUsdc.toFixed(2)}`
  );
  console.log(
    `  ${YELLOW}→${RESET} Minting $${topUpAmount.toFixed(2)} devnet USDC to wallet ATA...`
  );

  const tokenFaucet = new TokenFaucet(
    driftClient.connection as any,
    wallet as any,
    FAUCET_PROGRAM_ID,
    DRIFT_DEVNET_USDC_MINT
  );

  const faucetAmount = new BN(topUpAmount.mul(1e6).toFixed(0));
  const [tokenAccount, mintTxSig] =
    await tokenFaucet.createAssociatedTokenAccountAndMintTo(
      wallet.publicKey as any,
      faucetAmount
    );

  console.log(`  ${GREEN}✓${RESET} Faucet mint tx: ${mintTxSig}`);
  console.log(`  ${GREEN}✓${RESET} Wallet USDC ATA: ${tokenAccount.toBase58()}`);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const refreshedWalletUsdcAccount = await getAccount(
    driftClient.connection,
    walletUsdcAta
  );
  walletUsdcBalance = new Decimal(
    refreshedWalletUsdcAccount.amount.toString()
  ).div(1e6);
  console.log(
    `  ${GREEN}✓${RESET} Updated wallet devnet USDC: $${walletUsdcBalance.toFixed(2)}`
  );
}

async function main() {
  if (config.driftEnv !== "devnet") {
    throw new Error(
      `This workflow is devnet-only. Current DRIFT_ENV=${config.driftEnv}`
    );
  }

  const depositAmount = new Decimal(parseArg("--deposit", "10") || "10");
  const withdrawAmount = new Decimal(
    parseArg("--withdraw", depositAmount.div(2).toFixed(2)) ||
      depositAmount.div(2).toFixed(2)
  );
  const redeemPeriod = parseInt(parseArg("--redeem-period", "0") || "0", 10);
  const vaultArg = parseArg("--vault");
  const keepVault = hasFlag("--keep-vault");
  const skipInit = hasFlag("--skip-init");
  const skipWithdraw = hasFlag("--skip-withdraw");
  const vaultName =
    parseArg("--name") ||
    `DriftBearDevnet${Math.floor(Date.now() / 1000)
      .toString()
      .slice(-6)}`;

  if (depositAmount.lte(0)) {
    throw new Error("--deposit must be > 0");
  }
  if (withdrawAmount.lte(0)) {
    throw new Error("--withdraw must be > 0");
  }

  console.log(`\n${BOLD}═══ Drift Devnet Vault Workflow ═══${RESET}\n`);
  console.log(`  RPC:           ${config.solanaRpcUrl}`);
  console.log(`  Deposit:       $${depositAmount.toFixed(2)} USDC`);
  console.log(`  Withdraw:      $${withdrawAmount.toFixed(2)} USDC`);
  console.log(`  Redeem period: ${redeemPeriod}s`);
  console.log(`  Keep vault:    ${keepVault ? "yes" : "no"}`);
  console.log();

  const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;
  if (!keypairSource) {
    throw new Error("Set ANCHOR_WALLET or SOLANA_PRIVATE_KEY before running");
  }

  const drift = new DriftManager({ keypair: keypairSource });
  await drift.initialize();

    const vaultManager = new DriftVaultManager(drift.getClient(), drift.getWallet());
  await vaultManager.initialize();

  try {
    console.log(`${BOLD}${CYAN}1. Funding Drift Account${RESET}`);
    await ensureWalletUsdcBalance(
      drift,
      depositAmount
    );

    let vaultAddress: PublicKey;

    if (vaultArg) {
      vaultAddress = new PublicKey(vaultArg);
      console.log(`\n${BOLD}${CYAN}2. Using Existing Vault${RESET}`);
      console.log(`  Vault: ${vaultAddress.toBase58()}`);
    } else {
      if (skipInit) {
        throw new Error("--skip-init requires --vault");
      }

      console.log(`\n${BOLD}${CYAN}2. Initializing Vault${RESET}`);
      const { vaultAddress: createdVault, txSig } =
        await vaultManager.initializeVault({
          name: vaultName,
          spotMarketIndex: 0,
          redeemPeriod,
          managementFee: 0,
          profitShare: 0,
          maxTokens: 0,
          permissioned: false,
        });
      vaultAddress = createdVault;

      console.log(`  ${GREEN}✓${RESET} Vault created: ${vaultAddress.toBase58()}`);
      console.log(`  ${GREEN}✓${RESET} Init tx: ${txSig}`);

      const delegateTx = await vaultManager.updateDelegate(
        vaultAddress,
        drift.getWallet().publicKey
      );
      console.log(`  ${GREEN}✓${RESET} Delegate set: ${delegateTx}`);

      const marginTx = await vaultManager.enableMarginTrading(vaultAddress);
      console.log(`  ${GREEN}✓${RESET} Margin enabled: ${marginTx}`);
    }

    const equityBeforeDeposit = await vaultManager.getVaultEquity(vaultAddress);

    console.log(`\n${BOLD}${CYAN}3. Manager Deposit${RESET}`);
    const depositTx = await vaultManager.managerDeposit(vaultAddress, depositAmount);
    const equityAfterDeposit = await vaultManager.getVaultEquity(vaultAddress);
    console.log(`  ${GREEN}✓${RESET} Deposit tx: ${depositTx}`);
    console.log(
      `  ${GREEN}✓${RESET} Vault equity: $${equityBeforeDeposit.toFixed(2)} -> $${equityAfterDeposit.toFixed(2)}`
    );

    if (!skipWithdraw) {
      console.log(`\n${BOLD}${CYAN}4. Withdraw Request${RESET}`);
      const requestTx = await vaultManager.managerRequestWithdraw(
        vaultAddress,
        withdrawAmount
      );
      console.log(`  ${GREEN}✓${RESET} Withdraw request tx: ${requestTx}`);

      if (redeemPeriod === 0) {
        console.log(`\n${BOLD}${CYAN}5. Complete Withdraw${RESET}`);
        const completeTx = await vaultManager.managerWithdraw(vaultAddress);
        const finalEquity = await vaultManager.getVaultEquity(vaultAddress);
        console.log(`  ${GREEN}✓${RESET} Withdraw complete tx: ${completeTx}`);
        console.log(`  ${GREEN}✓${RESET} Final vault equity: $${finalEquity.toFixed(2)}`);
      } else {
        console.log(
          `  ${YELLOW}!${RESET} Redeem period is non-zero, so completion is deferred.`
        );
        console.log(
          `  ${YELLOW}!${RESET} Re-run with --vault ${vaultAddress.toBase58()} after ${redeemPeriod}s and pass --skip-init`
        );
      }
    }

    const vaultInfo = await vaultManager.getVault(vaultAddress);
    console.log(`\n${BOLD}${CYAN}Summary${RESET}`);
    console.log(`  Vault:      ${vaultAddress.toBase58()}`);
    console.log(`  Drift user: ${vaultInfo.user.toBase58()}`);
    console.log(`  Manager:    ${vaultInfo.manager.toBase58()}`);
    console.log(`  Delegate:   ${vaultInfo.delegate.toBase58()}`);

    if (!keepVault) {
      console.log(
        `  Note: vault kept on devnet for inspection. There is no destructive cleanup in this runner.`
      );
    }
  } finally {
    await vaultManager.shutdown();
    await drift.shutdown();
  }
}

main().catch((err) => {
  console.error("\nWorkflow failed:", err);
  process.exit(1);
});
