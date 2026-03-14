/**
 * Withdraw USDC from the Drift strategy back to the Ranger Earn vault's idle account.
 *
 * Usage:
 *   HELIUS_RPC_URL=<url> VAULT_PUBKEY=<pubkey> MANAGER_FILE_PATH=<path> \
 *     npx ts-node scripts/withdraw-ranger-strategy.ts --amount 20
 *
 * Required env:
 *   HELIUS_RPC_URL      — Helius RPC endpoint
 *   VAULT_PUBKEY        — Ranger Earn vault pubkey
 *   MANAGER_FILE_PATH   — Path to manager keypair JSON
 */
import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DriftClient, Wallet } from "@drift-labs/sdk";
import {
  sendAndConfirmOptimisedTx,
  setupTokenAccount,
  getAddressLookupTableAccounts,
} from "./utils/helper";

// ── Constants ────────────────────────────────────────────────────────────────
const ADAPTOR_PROGRAM_ID = "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP";
const DRIFT_PROGRAM_ID   = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const DRIFT_STATE        = "5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN";
const USDC_MINT          = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DRIFT_LUT          = "Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL";

// WITHDRAW_USER discriminator (from voltrxyz/drift-scripts/src/constants/drift.ts)
const DISCRIMINATOR_WITHDRAW_USER = Buffer.from([86, 169, 152, 107, 33, 180, 134, 115]);

const USDC_MARKET_INDEX = 0;
const SUB_ACCOUNT_ID    = 0;

// ── Load manager keypair ──────────────────────────────────────────────────────
const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
const payerKp     = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(payerKpFile)));
const payer       = payerKp.publicKey;

const vault             = new PublicKey(process.env.VAULT_PUBKEY!);
const vaultAssetMint    = new PublicKey(USDC_MINT);
const assetTokenProgram = TOKEN_PROGRAM_ID;

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc         = new VoltrClient(connection);

const main = async () => {
  const args      = process.argv.slice(2);
  const getArg    = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
  const amountStr = getArg("--amount");
  if (!amountStr) { console.error("Error: --amount required (e.g., --amount 20)"); process.exit(1); }
  const withdrawAmount = new BN(Math.round(parseFloat(amountStr) * 1_000_000));

  // ── Derive accounts ─────────────────────────────────────────────────────────
  // Withdraw uses "drift_user" seed (same as deposit)
  const [strategy] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_user")],
    new PublicKey(ADAPTOR_PROGRAM_ID)
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);

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
  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new BN(USDC_MARKET_INDEX).toArrayLike(Buffer, "le", 2),
    ],
    new PublicKey(DRIFT_PROGRAM_ID)
  );
  // driftSigner: PDA from ["drift_signer"] in Drift program (withdraw only)
  const [driftSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_signer")],
    new PublicKey(DRIFT_PROGRAM_ID)
  );

  console.log("\n═══ Withdraw from Drift Strategy — Ranger Earn Vault ═══\n");
  console.log("  vault:            ", vault.toBase58());
  console.log("  strategy:         ", strategy.toBase58());
  console.log("  vaultStrategyAuth:", vaultStrategyAuth.toBase58());
  console.log("  amount:           ", parseFloat(amountStr).toFixed(2), "USDC");

  let transactionIxs: TransactionInstruction[] = [];

  // ── Setup vaultStrategyAuth token account ────────────────────────────────
  await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  // ── Fetch remaining accounts via DriftClient ──────────────────────────────
  const driftClient = new DriftClient({
    connection,
    wallet: new Wallet(payerKp),
    env: "mainnet-beta",
    skipLoadUsers: true,
  });
  await driftClient.subscribe();

  const userAccounts = await driftClient.getUserAccountsForAuthority(vaultStrategyAuth);

  const driftRemainingAccounts = driftClient.getRemainingAccounts({
    userAccounts,
    useMarketLastSlotCache: false,
    writableSpotMarketIndexes: [USDC_MARKET_INDEX],
  });

  await driftClient.unsubscribe();

  // ── Build remaining accounts ──────────────────────────────────────────────
  // Order (from voltrxyz/drift-scripts/manager-withdraw-user.ts):
  // [driftSigner (w), counterPartyTa (w), protocolProgram, userStats (w), user (w), state, ...driftRemaining]
  const remainingAccounts = [
    { pubkey: driftSigner,                 isSigner: false, isWritable: true  },
    { pubkey: counterPartyTa,              isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(DRIFT_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: userStats,                   isSigner: false, isWritable: true  },
    { pubkey: user,                        isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(DRIFT_STATE),  isSigner: false, isWritable: false },
    ...driftRemainingAccounts,
  ];

  // ── additionalArgs: market index as 2-byte LE ─────────────────────────────
  const additionalArgs = Buffer.from([
    ...new BN(USDC_MARKET_INDEX).toArrayLike(Buffer, "le", 2),
  ]);

  // ── Build withdraw instruction ────────────────────────────────────────────
  const createWithdrawStrategyIx = await vc.createWithdrawStrategyIx(
    {
      instructionDiscriminator: DISCRIMINATOR_WITHDRAW_USER,
      withdrawAmount,
      additionalArgs,
    },
    {
      manager: payer,
      vault,
      vaultAssetMint,
      assetTokenProgram,
      strategy,
      remainingAccounts,
      adaptorProgram: new PublicKey(ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(createWithdrawStrategyIx);

  const lookupTableAccounts = await getAddressLookupTableAccounts(
    [DRIFT_LUT],
    connection
  );

  console.log("\n[1/1] Sending withdraw transaction...");
  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    [],
    lookupTableAccounts
  );
  console.log("  tx:", txSig);
  console.log("\n✓ USDC withdrawn from Drift strategy to vault.");
};

main().catch((err) => {
  console.error("Withdraw failed:", err);
  process.exit(1);
});
