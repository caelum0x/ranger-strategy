/**
 * Initialize Drift spot/perps strategy on a Ranger Earn vault.
 *
 * One-time setup. Creates the Drift UserStats + User accounts that the vault
 * will trade through via the Drift adaptor.
 *
 * Usage:
 *   HELIUS_RPC_URL=<url> VAULT_PUBKEY=<pubkey> MANAGER_FILE_PATH=<path> \
 *     npx ts-node scripts/init-strategy.ts
 *
 * Required env:
 *   HELIUS_RPC_URL      — Helius RPC endpoint (supports getPriorityFeeEstimate)
 *   VAULT_PUBKEY        — Ranger Earn vault pubkey (from init-vault.ts)
 *   MANAGER_FILE_PATH   — Path to manager keypair JSON (array of bytes)
 *
 * After running:
 *   Add STRATEGY_PUBKEY=<output> to .env
 */
import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { sendAndConfirmOptimisedTx, setupTokenAccount } from "./utils/helper";

// ── Constants ────────────────────────────────────────────────────────────────
const ADAPTOR_PROGRAM_ID = "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP";
const DRIFT_PROGRAM_ID   = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
// Hardcoded — not dynamically derived (matches voltrxyz/drift-scripts)
const DRIFT_STATE        = "5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN";
const USDC_MINT          = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// INITIALIZE_USER discriminator (from voltrxyz/drift-scripts/src/constants/drift.ts)
const DISCRIMINATOR_INITIALIZE_USER = Buffer.from([200, 103, 130, 67, 230, 84, 7, 225]);

const SUB_ACCOUNT_ID   = 0;
const ENABLE_MARGIN    = false;

// ── Load manager keypair ──────────────────────────────────────────────────────
const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
const payerKp     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(payerKpFile)));
const payer       = payerKp.publicKey;

const vault            = new PublicKey(process.env.VAULT_PUBKEY!);
const vaultAssetMint   = new PublicKey(USDC_MINT);
const assetTokenProgram = TOKEN_PROGRAM_ID;

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc         = new VoltrClient(connection);

const main = async () => {
  // ── Derive strategy PDA ─────────────────────────────────────────────────────
  // Seed: "drift_user_curve" (perps/margin variant), NO vault buffer
  const [strategy] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_user_curve")],
    new PublicKey(ADAPTOR_PROGRAM_ID)
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

  // Drift user accounts (derived via findProgramAddressSync, not SDK helpers)
  const subAccountIdBN = new BN(SUB_ACCOUNT_ID);
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    new PublicKey(DRIFT_PROGRAM_ID)
  );
  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      subAccountIdBN.toArrayLike(Buffer, "le", 2),
    ],
    new PublicKey(DRIFT_PROGRAM_ID)
  );

  console.log("\n═══ Init Drift Strategy — Ranger Earn Vault ═══\n");
  console.log("  vault:            ", vault.toBase58());
  console.log("  strategy:         ", strategy.toBase58());
  console.log("  vaultStrategyAuth:", vaultStrategyAuth.toBase58());
  console.log("  userStats:        ", userStats.toBase58());
  console.log("  user:             ", user.toBase58());
  console.log("  payer/manager:    ", payer.toBase58());

  let transactionIxs: TransactionInstruction[] = [];

  // ── Setup vaultStrategyAuth token account ────────────────────────────────
  // Must be created before calling the init instruction
  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );
  console.log("  vaultStrategyAssetAta:", vaultStrategyAssetAta.toBase58());

  // ── Build additionalArgs: vault name + enableMarginTrading byte ────────────
  const vaultAccount  = await vc.fetchVaultAccount(vault);
  const vaultName     = Buffer.from(vaultAccount.name);
  const marginFlag    = Buffer.from(ENABLE_MARGIN ? [1] : [0]);
  const additionalArgs = Buffer.concat([vaultName, marginFlag], vaultName.length + marginFlag.length);

  console.log("  vault name:       ", Buffer.from(vaultAccount.name).toString("utf-8").replace(/\0/g, ""));
  console.log("  enableMargin:     ", ENABLE_MARGIN);

  // ── Build init instruction ────────────────────────────────────────────────
  // Remaining accounts order (from voltrxyz/drift-scripts/manager-init-user.ts):
  //   [protocolProgram, userStats (w), user (w), state (w), delegatee, SYSVAR_RENT]
  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: DISCRIMINATOR_INITIALIZE_USER,
      additionalArgs,
    },
    {
      payer,
      vault,
      manager: payer,
      strategy,
      remainingAccounts: [
        { pubkey: new PublicKey(DRIFT_PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: userStats,                        isSigner: false, isWritable: true  },
        { pubkey: user,                             isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(DRIFT_STATE),       isSigner: false, isWritable: true  },
        { pubkey: payer,                            isSigner: false, isWritable: false }, // delegatee
        { pubkey: SYSVAR_RENT_PUBKEY,               isSigner: false, isWritable: false },
      ],
      adaptorProgram: new PublicKey(ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  console.log("\n[1/1] Sending init transaction...");
  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp
  );
  console.log("  tx:", txSig);

  console.log("\n✓ Drift strategy initialized");
  console.log("\nAdd to .env:");
  console.log("  STRATEGY_PUBKEY=" + strategy.toBase58());
  console.log("\nNext: npx ts-node scripts/deposit-ranger-strategy.ts --amount 20");
};

main().catch((err) => {
  console.error("Strategy init failed:", err);
  process.exit(1);
});
