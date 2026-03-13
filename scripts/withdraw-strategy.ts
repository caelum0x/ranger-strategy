/**
 * Withdraw from the Drift vault.
 *
 * Withdrawal is a 2-step process:
 *   Step 1: Request withdrawal (starts redeem period)
 *   Step 2: Complete withdrawal (after redeem period elapses)
 *
 * Usage:
 *   npx ts-node scripts/withdraw-strategy.ts --request --amount 10 [--vault <VAULT_ADDRESS>]
 *   npx ts-node scripts/withdraw-strategy.ts --complete [--vault <VAULT_ADDRESS>]
 *   npx ts-node scripts/withdraw-strategy.ts --cancel [--vault <VAULT_ADDRESS>]
 *   npx ts-node scripts/withdraw-strategy.ts --status [--vault <VAULT_ADDRESS>]
 */
import { DriftManager } from "../src/drift/client";
import { DriftVaultManager } from "../src/drift/vault";
import { config } from "../src/config";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const keypairSource = process.env.ANCHOR_WALLET || config.solanaPrivateKey;
  if (!keypairSource) {
    console.error("Error: Set ANCHOR_WALLET or SOLANA_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const getArg = (flag: string, defaultVal: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
  };

  const vaultAddressStr =
    getArg("--vault", "") || process.env.DRIFT_VAULT_PUBKEY || "";
  if (!vaultAddressStr) {
    console.error(
      "Error: Provide --vault <ADDRESS> or set DRIFT_VAULT_PUBKEY in .env"
    );
    process.exit(1);
  }

  const vaultAddress = new PublicKey(vaultAddressStr);
  const isRequest = args.includes("--request");
  const isComplete = args.includes("--complete");
  const isCancel = args.includes("--cancel");
  const isStatus = args.includes("--status");
  const isDepositor = args.includes("--as-depositor");

  if (!isRequest && !isComplete && !isCancel && !isStatus) {
    console.error(
      "Error: Specify one of --request, --complete, --cancel, or --status"
    );
    console.error("\nExamples:");
    console.error(
      "  npx ts-node scripts/withdraw-strategy.ts --request --amount 10"
    );
    console.error("  npx ts-node scripts/withdraw-strategy.ts --complete");
    console.error("  npx ts-node scripts/withdraw-strategy.ts --cancel");
    console.error("  npx ts-node scripts/withdraw-strategy.ts --status");
    process.exit(1);
  }

  // Initialize
  const drift = new DriftManager({ keypair: keypairSource });
  await drift.initialize();

  const driftClient = drift.getClient();
  const wallet = drift.getWallet();

  const vaultManager = new DriftVaultManager(driftClient, wallet);
  await vaultManager.initialize();

  console.log(`\n=== VAULT WITHDRAWAL ===\n`);
  console.log(`Vault: ${vaultAddress.toBase58()}`);
  console.log(`Mode:  ${isDepositor ? "Depositor" : "Manager"}`);

  // Show current vault state
  const vaultInfo = await vaultManager.getVault(vaultAddress);
  const equity = await vaultManager.getVaultEquity(vaultAddress);
  console.log(`Equity: $${equity.toFixed(2)}\n`);

  if (isStatus) {
    // Show withdrawal status
    const req = vaultInfo.lastManagerWithdrawRequest;
    if (req.ts.toNumber() === 0) {
      console.log("No pending manager withdrawal request.");
    } else {
      const requestedAt = new Date(req.ts.toNumber() * 1000);
      const redeemAfter = new Date(
        (req.ts.toNumber() + vaultInfo.redeemPeriod) * 1000
      );
      const now = new Date();
      const canWithdraw = now >= redeemAfter;

      console.log("--- Pending Manager Withdrawal ---");
      console.log(`Requested at:  ${requestedAt.toISOString()}`);
      console.log(`Redeem period: ${vaultInfo.redeemPeriod}s (${(vaultInfo.redeemPeriod / 86400).toFixed(1)} days)`);
      console.log(`Can withdraw:  ${redeemAfter.toISOString()}`);
      console.log(
        `Status:        ${canWithdraw ? "READY to complete" : `Wait ${Math.ceil((redeemAfter.getTime() - now.getTime()) / 3600000)}h`}`
      );
      console.log(`Shares:        ${req.shares.toString()}`);
      console.log(`Value:         ${req.value.toString()}`);
    }

    // Show depositor withdrawals
    if (isDepositor) {
      const depositorAddress = vaultManager.getDepositorAddress(
        vaultAddress,
        wallet.publicKey
      );
      try {
        const depositors = await vaultManager.getDepositors(vaultAddress);
        const myDepositor = depositors.find(
          (d) => d.authority.toBase58() === wallet.publicKey.toBase58()
        );
        if (myDepositor) {
          const req = myDepositor.lastWithdrawRequest;
          if (req.ts.toNumber() > 0) {
            console.log("\n--- Pending Depositor Withdrawal ---");
            console.log(
              `Requested at: ${new Date(req.ts.toNumber() * 1000).toISOString()}`
            );
            console.log(`Shares: ${req.shares.toString()}`);
            console.log(`Value: ${req.value.toString()}`);
          }
        }
      } catch {
        console.log("Could not fetch depositor info");
      }
    }
  } else if (isRequest) {
    const amountStr = getArg("--amount", "0");
    const amount = parseFloat(amountStr);
    if (amount <= 0) {
      console.error("Error: --amount required (e.g., --request --amount 10)");
      process.exit(1);
    }

    console.log(`Requesting withdrawal of $${amount.toFixed(2)} USDC...`);

    if (isDepositor) {
      const depositorAddress = vaultManager.getDepositorAddress(
        vaultAddress,
        wallet.publicKey
      );
      const txSig = await vaultManager.requestWithdraw(
        depositorAddress,
        new Decimal(amount)
      );
      console.log(`Withdraw request tx: ${txSig}`);
    } else {
      const txSig = await vaultManager.managerRequestWithdraw(
        vaultAddress,
        new Decimal(amount)
      );
      console.log(`Withdraw request tx: ${txSig}`);
    }

    console.log(
      `\nRedeem period: ${vaultInfo.redeemPeriod}s (${(vaultInfo.redeemPeriod / 86400).toFixed(1)} days)`
    );
    console.log("Run --complete after the redeem period elapses.");
  } else if (isComplete) {
    console.log("Completing withdrawal...");

    if (isDepositor) {
      const depositorAddress = vaultManager.getDepositorAddress(
        vaultAddress,
        wallet.publicKey
      );
      const txSig = await vaultManager.withdraw(depositorAddress);
      console.log(`Withdrawal completed: ${txSig}`);
    } else {
      const txSig = await vaultManager.managerWithdraw(vaultAddress);
      console.log(`Withdrawal completed: ${txSig}`);
    }

    const equityAfter = await vaultManager.getVaultEquity(vaultAddress);
    console.log(`Vault equity after: $${equityAfter.toFixed(2)}`);
  } else if (isCancel) {
    console.log("Cancelling withdrawal request...");

    const txSig = await vaultManager.managerCancelWithdrawRequest(vaultAddress);
    console.log(`Cancel tx: ${txSig}`);
    console.log("Withdrawal request cancelled.");
  }

  await vaultManager.shutdown();
  await drift.shutdown();
}

main().catch((err) => {
  console.error("Withdrawal operation failed:", err);
  process.exit(1);
});
