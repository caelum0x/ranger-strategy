import { VoltrClient, VaultConfig, VaultParams } from "@voltr/vault-sdk";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

const DRIFT_ADAPTOR_PROGRAM_ID = new PublicKey(
  "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP"
);

// LP token metadata hosted on GitHub — update with your actual repo URL
// after pushing assets/metadata.json and assets/logo.png
const LP_METADATA_URI =
  process.env.LP_METADATA_URI ||
  "https://raw.githubusercontent.com/cmertmarangoz/ranger-strategy/main/assets/metadata.json";

async function sendIx(
  connection: Connection,
  ix: any,
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
}

async function main() {
  const rpcUrl =
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const client = new VoltrClient(connection);

  // ── Load keypairs ─────────────────────────────────────────────
  // ADMIN_KEYPAIR_PATH > ANCHOR_WALLET > admin.json
  const adminKpPath = process.env.ADMIN_KEYPAIR_PATH || process.env.ANCHOR_WALLET || "admin.json";
  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminKpPath, "utf-8")))
  );

  // MANAGER_KEYPAIR_PATH defaults to admin keypair (single-wallet setup)
  const managerKpPath = process.env.MANAGER_KEYPAIR_PATH || adminKpPath;
  const managerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(managerKpPath, "utf-8")))
  );

  // Generate vault keypair and persist it immediately before any RPC calls
  // so it can be recovered even if the script fails mid-way.
  const vaultKp = Keypair.generate();
  const vaultKpPath = process.env.VAULT_KEYPAIR_PATH || "vault-keypair.json";
  fs.writeFileSync(
    vaultKpPath,
    JSON.stringify(Array.from(vaultKp.secretKey))
  );
  console.log(`Vault keypair saved to ${vaultKpPath} (keep this safe!)`);

  // ── Step 1: Create vault ──────────────────────────────────────
  console.log("\n[1/4] Creating vault...");

  const vaultConfig: VaultConfig = {
    maxCap: new BN("18446744073709551615"), // Uncapped (u64 max)
    startAtTs: new BN(0),                   // Immediate activation
    lockedProfitDegradationDuration: new BN(86400), // 24h
    managerPerformanceFee: 2000,            // 20% performance fee
    adminPerformanceFee: 0,
    managerManagementFee: 100,              // 1% annual management fee
    adminManagementFee: 0,
    redemptionFee: 0,
    issuanceFee: 0,
    withdrawalWaitingPeriod: new BN(7776000), // 90-day lock (3 months, rolling)
  };

  // Both fields have hard on-chain limits — exceeding them fails the tx
  const name = "AI Delta-Neutral Vault";        // ≤32 chars (22)
  const description = "AI-powered USDC delta-neutral vault"; // ≤64 chars (37)

  const vaultParams: VaultParams = {
    config: vaultConfig,
    name,
    description,
  };

  const createVaultIx = await client.createInitializeVaultIx(vaultParams, {
    vault: vaultKp.publicKey,
    vaultAssetMint: USDC_MINT,
    admin: adminKp.publicKey,
    manager: managerKp.publicKey,
    payer: adminKp.publicKey,
  });

  const sig = await sendIx(connection, createVaultIx, [adminKp, vaultKp]);

  console.log("  Vault pubkey:", vaultKp.publicKey.toBase58());
  console.log("  Transaction:", sig);

  // ── Step 2: LP token metadata ─────────────────────────────────
  console.log("\n[2/4] Creating LP token metadata...");

  const metadataIx = await client.createCreateLpMetadataIx(
    {
      name: "AI DN Vault LP",  // ≤32 chars
      symbol: "aiDN",          // short ticker shown in wallets
      uri: LP_METADATA_URI,
    },
    {
      vault: vaultKp.publicKey,
      admin: adminKp.publicKey,
      payer: adminKp.publicKey,
    }
  );

  const metaSig = await sendIx(connection, metadataIx, [adminKp]);
  console.log("  LP metadata tx:", metaSig);

  // ── Step 3: Add Drift adaptor ─────────────────────────────────
  console.log("\n[3/4] Adding Drift adaptor...");

  const addAdaptorIx = await client.createAddAdaptorIx({
    vault: vaultKp.publicKey,
    admin: adminKp.publicKey,
    payer: adminKp.publicKey,
    adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
  });

  const adaptorSig = await sendIx(connection, addAdaptorIx, [adminKp]);
  console.log("  Adaptor tx:", adaptorSig);

  // ── Step 4: Save vault info ───────────────────────────────────
  console.log("\n[4/4] Saving vault info...");

  const vaultInfo = {
    vaultPubkey: vaultKp.publicKey.toBase58(),
    adminPubkey: adminKp.publicKey.toBase58(),
    managerPubkey: managerKp.publicKey.toBase58(),
    assetMint: USDC_MINT.toBase58(),
    adaptors: {
      drift: DRIFT_ADAPTOR_PROGRAM_ID.toBase58(),
    },
    lpMetadata: {
      name: "AI DN Vault LP",
      symbol: "aiDN",
      uri: LP_METADATA_URI,
    },
    createdAt: new Date().toISOString(),
    transactions: {
      createVault: sig,
      lpMetadata: metaSig,
      addAdaptor: adaptorSig,
    },
  };

  fs.writeFileSync("vault-info.json", JSON.stringify(vaultInfo, null, 2));

  console.log("\n✓ Vault initialized successfully");
  console.log("  vault-info.json written");
  console.log("\nNext steps:");
  console.log("  1. Add to .env:  VAULT_PUBKEY=" + vaultKp.publicKey.toBase58());
  console.log("  2. Initialize Drift strategy: npx ts-node scripts/devnet-setup.ts");
  console.log("  3. Deposit USDC:  npx ts-node scripts/deposit-strategy.ts");
  console.log("  4. Start agent:   npm run agent");
}

main().catch((err) => {
  console.error("Vault creation failed:", err);
  process.exit(1);
});
