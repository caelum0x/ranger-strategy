import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { sendAndConfirmOptimisedTx } from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import { lpTokenMetadata, vaultAddress } from "../../config/base";

const adminKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const adminKpData = JSON.parse(adminKpFile);
const adminSecret = Uint8Array.from(adminKpData);
const adminKp = Keypair.fromSecretKey(adminSecret);
const admin = adminKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const createLpMetadataHandler = async () => {
  const createLpMetadataIx = await vc.createCreateLpMetadataIx(
    lpTokenMetadata,
    {
      payer: admin,
      admin,
      vault,
    }
  );

  const txSig = await sendAndConfirmOptimisedTx(
    [createLpMetadataIx],
    process.env.HELIUS_RPC_URL!,
    adminKp
  );

  console.log(`Lp token metadata created with signature: ${txSig}`);
};

const main = async () => {
  await createLpMetadataHandler();
};

main();
