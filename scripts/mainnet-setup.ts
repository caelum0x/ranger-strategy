/**
 * Mainnet setup — creates a Drift vault, sets delegate, enables margin trading,
 * and deposits initial USDC. Outputs config values for .env.mainnet.
 *
 * Prerequisites:
 *   1. A mainnet keypair file with SOL (for fees) + USDC (for trading)
 *   2. .env.mainnet configured with RPC URL
 *
 * Usage:
 *   npx ts-node scripts/mainnet-setup.ts
 *   npx ts-node scripts/mainnet-setup.ts --deposit 50    # deposit 50 USDC
 *   npx ts-node scripts/mainnet-setup.ts --name "My Vault"
 *   npx ts-node scripts/mainnet-setup.ts --skip-init      # skip vault creation (already exists)
 *   npx ts-node scripts/mainnet-setup.ts --devnet          # run on devnet
 */
import dotenv from "dotenv";

const isDevnet = process.argv.includes("--devnet");
dotenv.config({ path: isDevnet ? ".env.devnet" : ".env.mainnet" });

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize as initDriftSdk,
  QUOTE_PRECISION,
  BN,
} from "@drift-labs/sdk";
import {
  VaultClient,
  getDriftVaultProgram,
  encodeName,
  getVaultAddressSync,
  VAULT_PROGRAM_ID,
} from "@drift-labs/vaults-sdk";
import * as fs from "fs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function getArg(flag: string, defaultValue: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return defaultValue;
}

async function main() {
  const env = isDevnet ? "devnet" : "mainnet-beta";
  const skipInit = process.argv.includes("--skip-init");
  const depositAmount = parseFloat(getArg("--deposit", "20"));
  const vaultName = getArg("--name", "Ranger Delta-Neutral");

  console.log(`\n${BOLD}╔════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  RANGER — MAINNET VAULT SETUP                  ║${RESET}`);
  console.log(`${BOLD}╚════════════════════════════════════════════════╝${RESET}\n`);
  console.log(`Environment: ${CYAN}${env}${RESET}`);
  console.log(`Vault name:  ${CYAN}${vaultName}${RESET}`);
  console.log(`Deposit:     ${CYAN}$${depositAmount} USDC${RESET}\n`);

  // ── 1. Load keypair ──────────────────────────────────────────────
  const keypairPath = process.env.ANCHOR_WALLET || process.env.KEYPAIR_PATH;
  if (!keypairPath) {
    console.error(`${RED}Set ANCHOR_WALLET in .env.mainnet to your keypair path${RESET}`);
    console.log(`\nExample: ANCHOR_WALLET=./mainnet-keypair.json`);
    console.log(`Create one: solana-keygen new -o mainnet-keypair.json`);
    process.exit(1);
  }

  if (!fs.existsSync(keypairPath)) {
    console.error(`${RED}Keypair not found: ${keypairPath}${RESET}`);
    console.log(`\nCreate one: solana-keygen new -o ${keypairPath}`);
    console.log(`Then fund it with SOL + USDC on mainnet.`);
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

  console.log(`${GREEN}Wallet: ${keypair.publicKey.toBase58()}${RESET}`);

  // ── 2. Connect to RPC ────────────────────────────────────────────
  const rpcUrl = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error(`${RED}No RPC URL configured (HELIUS_RPC_URL or SOLANA_RPC_URL)${RESET}`);
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);

  // ── 3. Check balances ────────────────────────────────────────────
  console.log(`\n${BOLD}Step 1: Checking balances...${RESET}`);

  const solBalance = await connection.getBalance(keypair.publicKey);
  const solAmount = solBalance / LAMPORTS_PER_SOL;
  console.log(`  SOL balance: ${solAmount >= 0.05 ? GREEN : RED}${solAmount.toFixed(4)} SOL${RESET}`);

  if (solAmount < 0.01) {
    console.error(`${RED}Need at least 0.01 SOL for transaction fees${RESET}`);
    process.exit(1);
  }

  // Check USDC balance
  const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");

  let usdcBalance = 0;
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      keypair.publicKey,
      { mint: USDC_MINT }
    );
    if (tokenAccounts.value.length > 0) {
      usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    }
  } catch {
    // May not have USDC account yet
  }
  console.log(`  USDC balance: ${usdcBalance >= depositAmount ? GREEN : RED}$${usdcBalance.toFixed(2)}${RESET}`);

  if (usdcBalance < depositAmount) {
    console.error(`${RED}Need at least $${depositAmount} USDC for initial deposit${RESET}`);
    console.log(`${YELLOW}Fund your wallet: ${keypair.publicKey.toBase58()}${RESET}`);
    console.log(`${YELLOW}Then re-run this script.${RESET}`);
    process.exit(1);
  }

  // ── 4. Initialize Drift client ───────────────────────────────────
  console.log(`\n${BOLD}Step 2: Connecting to Drift...${RESET}`);

  const sdkConfig = initDriftSdk({ env });
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 1000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    env,
    accountSubscription: { type: "polling", accountLoader },
  });

  await driftClient.subscribe();
  console.log(`  ${GREEN}Drift client connected${RESET}`);

  // Ensure Drift user account exists
  try {
    const user = driftClient.getUser();
    const freeCollateral = user.getFreeCollateral();
    console.log(`  Drift user account: ${GREEN}exists${RESET}`);
    console.log(`  Free collateral: $${(freeCollateral.toNumber() / 1e6).toFixed(2)}`);
  } catch {
    console.log(`  ${YELLOW}No Drift user account — will be created with vault${RESET}`);
  }

  // ── 5. Create or load Drift vault ────────────────────────────────
  const nameEncoded = encodeName(vaultName);
  const vaultAddress = getVaultAddressSync(VAULT_PROGRAM_ID, nameEncoded);

  console.log(`\n${BOLD}Step 3: Drift Vault setup...${RESET}`);
  console.log(`  Vault PDA: ${CYAN}${vaultAddress.toBase58()}${RESET}`);

  const vaultProgram = getDriftVaultProgram(connection as any, wallet as any) as any;
  const vaultClient = new VaultClient({
    driftClient: driftClient as any,
    program: vaultProgram,
    cliMode: true,
  });

  if (skipInit) {
    console.log(`  ${YELLOW}Skipping vault creation (--skip-init)${RESET}`);
  } else {
    // Check if vault already exists
    let vaultExists = false;
    try {
      await vaultClient.getVault(vaultAddress);
      vaultExists = true;
    } catch {
      vaultExists = false;
    }

    if (vaultExists) {
      console.log(`  ${GREEN}Vault already exists${RESET}`);
    } else {
      console.log(`  Creating vault "${vaultName}"...`);
      try {
        const txSig = await vaultClient.initializeVault({
          name: nameEncoded,
          spotMarketIndex: 0, // USDC
          redeemPeriod: new BN(7 * 24 * 3600), // 7 days
          maxTokens: new BN(0), // unlimited
          minDepositAmount: new BN(0),
          managementFee: new BN(0), // 0% management fee
          profitShare: 1000, // 10% performance fee
          hurdleRate: 0,
          permissioned: false,
        });
        console.log(`  ${GREEN}Vault created!${RESET} tx: ${txSig}`);
      } catch (err: any) {
        console.error(`  ${RED}Failed to create vault: ${err.message}${RESET}`);
        process.exit(1);
      }
    }
  }

  // ── 6. Configure vault delegate ──────────────────────────────────
  console.log(`\n${BOLD}Step 4: Setting vault delegate...${RESET}`);

  try {
    const vault = await vaultClient.getVault(vaultAddress);
    const currentDelegate = vault.delegate;

    if (currentDelegate.equals(keypair.publicKey)) {
      console.log(`  ${GREEN}Delegate already set to this wallet${RESET}`);
    } else if (currentDelegate.equals(PublicKey.default)) {
      console.log(`  Setting delegate to ${keypair.publicKey.toBase58()}...`);
      const txSig = await vaultClient.updateDelegate(vaultAddress, keypair.publicKey);
      console.log(`  ${GREEN}Delegate set!${RESET} tx: ${txSig}`);
    } else {
      console.log(`  ${YELLOW}Delegate already set to: ${currentDelegate.toBase58()}${RESET}`);
      console.log(`  ${YELLOW}Keeping existing delegate${RESET}`);
    }
  } catch (err: any) {
    console.error(`  ${RED}Failed to set delegate: ${err.message}${RESET}`);
  }

  // ── 7. Enable margin trading ─────────────────────────────────────
  console.log(`\n${BOLD}Step 5: Enabling margin trading...${RESET}`);

  try {
    const txSig = await vaultClient.updateMarginTradingEnabled(vaultAddress, true);
    console.log(`  ${GREEN}Margin trading enabled!${RESET} tx: ${txSig}`);
  } catch (err: any) {
    if (err.message?.includes("already")) {
      console.log(`  ${GREEN}Margin trading already enabled${RESET}`);
    } else {
      console.log(`  ${YELLOW}Margin trading update: ${err.message}${RESET}`);
    }
  }

  // ── 8. Manager deposit ───────────────────────────────────────────
  console.log(`\n${BOLD}Step 6: Depositing $${depositAmount} USDC...${RESET}`);

  try {
    const depositBN = new BN(Math.floor(depositAmount * 1e6));
    const txSig = await vaultClient.managerDeposit(vaultAddress, depositBN);
    console.log(`  ${GREEN}Deposited $${depositAmount} USDC!${RESET} tx: ${txSig}`);
  } catch (err: any) {
    console.error(`  ${RED}Deposit failed: ${err.message}${RESET}`);
    console.log(`  ${YELLOW}You may need to deposit manually or retry${RESET}`);
  }

  // ── 9. Final status ──────────────────────────────────────────────
  console.log(`\n${BOLD}Step 7: Final vault status${RESET}`);

  try {
    const vault = await vaultClient.getVault(vaultAddress);
    const equity = await vaultClient.calculateVaultEquity({
      address: vaultAddress,
      factorUnrealizedPNL: true,
    });

    console.log(`  Vault: ${CYAN}${vaultAddress.toBase58()}${RESET}`);
    console.log(`  Manager: ${vault.manager.toBase58()}`);
    console.log(`  Delegate: ${vault.delegate.toBase58()}`);
    console.log(`  User account: ${vault.user.toBase58()}`);
    console.log(`  Equity: $${(equity.toNumber() / 1e6).toFixed(2)}`);
    console.log(`  Total shares: ${vault.totalShares.toString()}`);
    console.log(`  Profit share: ${vault.profitShare / 100}%`);
    console.log(`  Redeem period: ${vault.redeemPeriod.toNumber() / 3600}h`);

    // ── 10. Output env config ────────────────────────────────────────
    console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
    console.log(`${BOLD}${GREEN}Add these to your .env.mainnet:${RESET}\n`);
    console.log(`DRIFT_VAULT_PUBKEY=${vaultAddress.toBase58()}`);
    console.log(`VAULT_PUBKEY=${vaultAddress.toBase58()}`);
    console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);

    console.log(`\n${GREEN}${BOLD}Setup complete!${RESET}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Add the env vars above to .env.mainnet`);
    console.log(`  2. Start the agent: ${CYAN}npm run agent${RESET}`);
    console.log(`  3. Check dashboard: ${CYAN}http://localhost:3000/dashboard${RESET}`);
    console.log(`  4. Verify on Solscan: ${CYAN}https://solscan.io/account/${vaultAddress.toBase58()}${RESET}\n`);
  } catch (err: any) {
    console.error(`  ${RED}Status check failed: ${err.message}${RESET}`);
  }

  await driftClient.unsubscribe();
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
