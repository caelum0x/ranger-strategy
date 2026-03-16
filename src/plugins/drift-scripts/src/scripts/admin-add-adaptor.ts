import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
} from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { ADAPTOR_PROGRAM_ID } from "../constants/drift";

const payerKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const addAdaptorHandler = async () => {
  const createAddAdaptorIx = await vc.createAddAdaptorIx({
    vault,
    payer,
    admin: payer,
    adaptorProgram: new PublicKey(ADAPTOR_PROGRAM_ID),
  });

  const transactionIxs0: TransactionInstruction[] = [];

  transactionIxs0.push(createAddAdaptorIx);

  const txSig0 = await sendAndConfirmOptimisedTx(
    transactionIxs0,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    []
  );

  await connection.confirmTransaction(txSig0, "finalized");
  console.log(`Adaptor added to vault with signature: ${txSig0}`);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    const lut = await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createAddAdaptorIx.keys.map((k) => k.pubkey.toBase58()),
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

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

const main = async () => {
  await addAdaptorHandler();
};

main();
