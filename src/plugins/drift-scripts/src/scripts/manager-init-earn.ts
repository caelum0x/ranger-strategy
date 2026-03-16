import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR, DRIFT } from "../constants/drift";
import { driftMarketIndex } from "../../config/drift";

const payerKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);
const vaultAssetTokenProgram = new PublicKey(assetTokenProgram);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const initDriftEarn = async (
  protocolProgram: PublicKey,
  state: PublicKey,
  subAccountId: BN,
  marketIndex: number,
  instructionDiscriminator: number[]
) => {
  const [spotMarketVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  const [spotMarket] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market"),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(
    vault,
    spotMarketVault
  );

  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    protocolProgram
  );

  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      subAccountId.toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  let transactionIxs: TransactionInstruction[] = [];

  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: Buffer.from(instructionDiscriminator),
    },
    {
      payer,
      vault,
      manager: payer,
      strategy: spotMarketVault,
      remainingAccounts: [
        { pubkey: protocolProgram, isSigner: false, isWritable: false },
        { pubkey: userStats, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: false, isWritable: true },
        { pubkey: spotMarket, isSigner: false, isWritable: false },
        { pubkey: state, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      adaptorProgram: new PublicKey(ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp
  );
  console.log("Drift strategy initialized with signature:", txSig);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeStrategyIx.keys.map((k) => k.pubkey.toBase58()),
          vaultStrategyAssetAta.toBase58(),
        ]),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log("LUT updated with signature:", txSig1);
  }
};

const main = async () => {
  await initDriftEarn(
    new PublicKey(DRIFT.PROGRAM_ID),
    new PublicKey(DRIFT.SPOT.STATE),
    new BN(DRIFT.SUB_ACCOUNT_ID),
    driftMarketIndex,
    DISCRIMINATOR.INITIALIZE_EARN
  );
};

main();
