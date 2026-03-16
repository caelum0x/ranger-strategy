import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
} from "../utils/helper";
import {
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { BN } from "@coral-xyz/anchor";
import { ADAPTOR_PROGRAM_ID, DRIFT } from "../constants/drift";
import {
  directWithdrawDiscriminator,
  driftMarketIndex,
} from "../../config/drift";

const initializeDirectWithdrawStrategy = async (
  connection: Connection,
  payerKp: Keypair,
  adminKp: Keypair,
  vault: PublicKey,
  adaptorProgram: PublicKey,
  protocolProgram: PublicKey,
  useLookupTable: boolean,
  lookupTableAddress: PublicKey,
  marketIndex: number,
  instructionDiscriminator: Buffer,
  additionalArgs: Buffer | null = null,
  allowUserArgs: boolean = false
) => {
  if (instructionDiscriminator.length !== 8) {
    throw new Error("Instruction discriminator must be 4 bytes");
  }
  const vc = new VoltrClient(connection);

  let transactionIxs: TransactionInstruction[] = [];

  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  const createInitializeDirectWithdrawIx =
    await vc.createInitializeDirectWithdrawStrategyIx(
      {
        instructionDiscriminator,
        additionalArgs,
        allowUserArgs,
      },
      {
        payer: payerKp.publicKey,
        admin: adminKp.publicKey,
        vault,
        strategy: counterPartyTa,
        adaptorProgram,
      }
    );

  transactionIxs.push(createInitializeDirectWithdrawIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    [adminKp],
    undefined
  );
  console.log(
    "Drift earn direct withdraw strategy initialized with signature:",
    txSig
  );

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    const lut = await setupAddressLookupTable(
      connection,
      payerKp.publicKey,
      adminKp.publicKey,
      [
        ...new Set(
          transactionIxs.flatMap((ix) =>
            ix.keys.map((k) => k.pubkey.toBase58())
          )
        ),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [adminKp],
      undefined,
      50_000
    );

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

const main = async () => {
  const payerKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
  const payerKpData = JSON.parse(payerKpFile);
  const payerSecret = Uint8Array.from(payerKpData);
  const payerKp = Keypair.fromSecretKey(payerSecret);
  const adminKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
  const adminKpData = JSON.parse(adminKpFile);
  const adminSecret = Uint8Array.from(adminKpData);
  const adminKp = Keypair.fromSecretKey(adminSecret);

  await initializeDirectWithdrawStrategy(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    adminKp,
    new PublicKey(vaultAddress),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(DRIFT.PROGRAM_ID),
    useLookupTable,
    new PublicKey(lookupTableAddress),
    driftMarketIndex,
    Buffer.from(directWithdrawDiscriminator),
    new BN(driftMarketIndex).toArrayLike(Buffer, "le", 2),
    false
  );
};

main();
