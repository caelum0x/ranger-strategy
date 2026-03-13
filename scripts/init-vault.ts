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

async function main() {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
  );
  const client = new VoltrClient(connection);

  // Load admin keypair
  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ADMIN_KEYPAIR_PATH || "admin.json",
          "utf-8"
        )
      )
    )
  );

  // Load or generate manager keypair
  const managerKp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.MANAGER_KEYPAIR_PATH || "manager.json",
          "utf-8"
        )
      )
    )
  );

  // Generate vault keypair
  const vaultKp = Keypair.generate();

  // Step 1: Create vault
  console.log("Creating vault...");

  const vaultConfig: VaultConfig = {
    maxCap: new BN("18446744073709551615"), // Uncapped (u64 max)
    startAtTs: new BN(0), // Immediate activation
    lockedProfitDegradationDuration: new BN(86400), // 24 hours
    managerPerformanceFee: 2000, // 20% performance fee
    adminPerformanceFee: 0,
    managerManagementFee: 100, // 1% management fee
    adminManagementFee: 0,
    redemptionFee: 0, // No redemption fee
    issuanceFee: 0, // No deposit fee
    withdrawalWaitingPeriod: new BN(3600), // 1 hour waiting period
  };

  const vaultParams: VaultParams = {
    config: vaultConfig,
    name: "AI Delta-Neutral Vault",
    description: "AI-powered USDC delta-neutral funding harvester",
  };

  const createVaultIx = await client.createInitializeVaultIx(vaultParams, {
    vault: vaultKp,
    vaultAssetMint: USDC_MINT,
    admin: adminKp.publicKey,
    manager: managerKp.publicKey,
    payer: adminKp.publicKey,
  });

  const tx = new Transaction().add(createVaultIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [
    adminKp,
    vaultKp,
  ]);

  console.log("Vault created!");
  console.log("  Vault pubkey:", vaultKp.publicKey.toBase58());
  console.log("  Transaction:", sig);

  // Step 2: Create LP token metadata
  console.log("\nCreating LP token metadata...");

  const metadataIx = await client.createCreateLpMetadataIx(
    {
      name: "AI DN Vault LP",
      symbol: "aiDN",
      uri: "https://raw.githubusercontent.com/your-repo/assets/main/metadata.json",
    },
    {
      vault: vaultKp.publicKey,
      admin: adminKp.publicKey,
      payer: adminKp.publicKey,
    }
  );

  const metaTx = new Transaction().add(metadataIx);
  const metaSig = await sendAndConfirmTransaction(connection, metaTx, [
    adminKp,
  ]);

  console.log("LP metadata created:", metaSig);

  // Step 3: Add Drift adaptor
  console.log("\nAdding Drift adaptor...");

  const addAdaptorIx = await client.createAddAdaptorIx({
    vault: vaultKp.publicKey,
    admin: adminKp.publicKey,
    payer: adminKp.publicKey,
    adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
  });

  const adaptorTx = new Transaction().add(addAdaptorIx);
  const adaptorSig = await sendAndConfirmTransaction(connection, adaptorTx, [
    adminKp,
  ]);

  console.log("Drift adaptor added:", adaptorSig);

  // Save vault info
  const vaultInfo = {
    vaultPubkey: vaultKp.publicKey.toBase58(),
    adminPubkey: adminKp.publicKey.toBase58(),
    managerPubkey: managerKp.publicKey.toBase58(),
    assetMint: USDC_MINT.toBase58(),
    adaptors: {
      drift: DRIFT_ADAPTOR_PROGRAM_ID.toBase58(),
    },
    createdAt: new Date().toISOString(),
    txSignature: sig,
  };

  fs.writeFileSync("vault-info.json", JSON.stringify(vaultInfo, null, 2));
  console.log("\nVault info saved to vault-info.json");
  console.log("\nNext steps:");
  console.log("  1. Add VAULT_PUBKEY to .env");
  console.log("  2. Initialize Drift strategy: npm run vault:init-strategy");
  console.log("  3. Deposit USDC: npm run vault:deposit");
  console.log("  4. Start agent: npm run agent");
}

main().catch(console.error);
