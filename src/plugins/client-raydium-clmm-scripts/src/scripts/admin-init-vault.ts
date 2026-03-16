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
  adminFilePath,
  assetMintAddress,
  heliusRpcUrl,
  managerFilePath,
  useLookupTable,
  vaultParams,
} from "../variables";
import { RAYDIUM_ADAPTOR_PROGRAM_ID } from "../constants/global";

const payerKpFile = fs.readFileSync(adminFilePath, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const managerKpFile = fs.readFileSync(managerFilePath, "utf-8");
const managerKpData = JSON.parse(managerKpFile);
const managerSecret = Uint8Array.from(managerKpData);
const managerKp = Keypair.fromSecretKey(managerSecret);
const manager = managerKp.publicKey;

const vaultKp = Keypair.generate();
const vault = vaultKp.publicKey;
const vaultAssetMint = new PublicKey(assetMintAddress);

const connection = new Connection(heliusRpcUrl);
const vc = new VoltrClient(connection);

const initVaultAndAddAdaptorHandler = async () => {
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
  const createAddAdaptorIx = await vc.createAddAdaptorIx({
    vault,
    admin: payer,
    payer,
    adaptorProgram: new PublicKey(RAYDIUM_ADAPTOR_PROGRAM_ID),
  });

  const transactionIxs0: TransactionInstruction[] = [];

  transactionIxs0.push(createInitializeVaultIx);
  transactionIxs0.push(createAddAdaptorIx);

  const txSig0 = await sendAndConfirmOptimisedTx(
    transactionIxs0,
    heliusRpcUrl,
    payerKp,
    [vaultKp]
  );

  await connection.confirmTransaction(txSig0, "finalized");
  console.log(`Vault initialized and adaptor added with signature: ${txSig0}`);
  console.log(`Update address into variables.ts`);
  console.log("Vault:", vault.toBase58());

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    const lut = await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeVaultIx.keys.map((k) => k.pubkey.toBase58()),
          ...createAddAdaptorIx.keys.map((k) => k.pubkey.toBase58()),
        ]),
      ],
      transactionIxs1
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      heliusRpcUrl,
      payerKp,
      []
    );
    console.log(`LUT created with signature: ${txSig1}`);
    console.log(`Update address into variables.ts`);
    console.log("Lookup Table:", lut.toBase58());
  }
};

const main = async () => {
  await initVaultAndAddAdaptorHandler();
};

main();
