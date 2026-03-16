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
  lpTokenMetadata,
  useLookupTable,
  vaultParams,
} from "../../config/base";

const adminKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const adminKpData = JSON.parse(adminKpFile);
const adminSecret = Uint8Array.from(adminKpData);
const adminKp = Keypair.fromSecretKey(adminSecret);
const admin = adminKp.publicKey;

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

const initVaultAndSetTokenMetadataHandler = async () => {
  const createInitializeVaultIx = await vc.createInitializeVaultIx(
    vaultParams,
    {
      vault,
      vaultAssetMint,
      admin,
      manager,
      payer: admin,
    }
  );

  const createLpMetadataIx = await vc.createCreateLpMetadataIx(
    lpTokenMetadata,
    {
      payer: admin,
      admin,
      vault,
    }
  );

  const transactionIxs0: TransactionInstruction[] = [];

  transactionIxs0.push(createInitializeVaultIx);
  transactionIxs0.push(createLpMetadataIx);
  const txSig0 = await sendAndConfirmOptimisedTx(
    transactionIxs0,
    process.env.HELIUS_RPC_URL!,
    adminKp,
    [vaultKp]
  );

  await connection.confirmTransaction(txSig0, "finalized");
  console.log(`Vault initialized and adaptor added with signature: ${txSig0}`);
  console.log(`Update below vault address into config/base.ts`);
  console.log("Vault:", vault.toBase58());

  if (useLookupTable) {
    const [createLUTIx, lookupTable] =
      AddressLookupTableProgram.createLookupTable({
        authority: admin,
        payer: admin,
        recentSlot: await connection.getSlot(),
      });

    const txSig1 = await sendAndConfirmOptimisedTx(
      [createLUTIx],
      process.env.HELIUS_RPC_URL!,
      adminKp,
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
      admin,
      admin,
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
      adminKp,
      [],
      undefined,
      50_000
    );

    console.log(`LUT extended with signature: ${txSig2}`);
  }
};

const main = async () => {
  await initVaultAndSetTokenMetadataHandler();
};

main();
