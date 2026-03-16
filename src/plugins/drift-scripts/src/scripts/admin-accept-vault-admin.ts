import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { sendAndConfirmOptimisedTx } from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import { vaultAddress } from "../../config/base";

const pendingAdminKpFile = fs.readFileSync(
  process.env.ADMIN_FILE_PATH!,
  "utf-8"
);
const pendingAdminKpData = JSON.parse(pendingAdminKpFile);
const pendingAdminSecret = Uint8Array.from(pendingAdminKpData);
const pendingAdminKp = Keypair.fromSecretKey(pendingAdminSecret);
const pendingAdmin = pendingAdminKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const acceptVaultAdminHandler = async () => {
  const acceptVaultAdminIx = await vc.createAcceptVaultAdminIx({
    pendingAdmin,
    vault,
  });

  const txSig = await sendAndConfirmOptimisedTx(
    [acceptVaultAdminIx],
    process.env.HELIUS_RPC_URL!,
    pendingAdminKp
  );

  console.log(`Accepted vault admin with signature: ${txSig}`);
};

const main = async () => {
  await acceptVaultAdminHandler();
};

main();
