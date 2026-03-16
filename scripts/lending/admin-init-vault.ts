import "dotenv/config";
import {
  AddressLookupTableProgram,
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
  assetMintAddress,
  useLookupTable,
  vaultParams,
} from "../../config/base";

const payerKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const managerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
const managerKpData = JSON.parse(managerKpFile);
const managerSecret = Uint8Array.from(managerKpData);
const managerKp = Keypair.fromSecretKey(managerSecret);
const manager = managerKp.publicKey;

const vaultKp = Keypair.generate();
const vault = vaultKp.publicKey;
const vaultAssetMint = new PublicKey(assetMintAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const initVaultHandler = async () => {
  const createInitializeVaultIx = await vc.createInitializeVaultIx(
    vaultParams,
    {
      vault,
      vaultAssetMint,
      admin: payer,
      manager,
      payer,
    }
  );

  const transactionIxs0: TransactionInstruction[] = [];

  transactionIxs0.push(createInitializeVaultIx);

  const txSig0 = await sendAndConfirmOptimisedTx(
    transactionIxs0,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    [vaultKp]
  );

  await connection.confirmTransaction(txSig0, "finalized");
  console.log(`Vault initialized and adaptor added with signature: ${txSig0}`);
  console.log(`Update below vault address into config/base.ts`);
  console.log("Vault:", vault.toBase58());

  if (useLookupTable) {
    const [createLUTIx, lookupTable] =
      AddressLookupTableProgram.createLookupTable({
        authority: payer,
        payer,
        recentSlot: await connection.getSlot(),
      });

    const txSig1 = await sendAndConfirmOptimisedTx(
      [createLUTIx],
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log(`LUT created with signature: ${txSig1}`);
    console.log(`Update below LUT address into config/base.ts`);
    console.log("LUT:", lookupTable.toBase58());

    const transactionIxs1: TransactionInstruction[] = [];

    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeVaultIx.keys.map((k) => k.pubkey.toBase58()),
        ]),
      ],
      transactionIxs1,
      lookupTable
    );

    const txSig2 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [],
      undefined,
      50_000
    );

    console.log(`LUT extended with signature: ${txSig2}`);
  }
};

const main = async () => {
  await initVaultHandler();
};

main();
