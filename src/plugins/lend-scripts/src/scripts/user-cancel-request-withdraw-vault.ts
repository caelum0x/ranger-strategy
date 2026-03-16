// NOTE: WILL ONLY SUCCEED IF THERE IS A REQUEST WITHDRAWAL OUTSTANDING
import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import { sendAndConfirmOptimisedTx } from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import { vaultAddress } from "../../config/base";

const userKpFile = fs.readFileSync(process.env.USER_KP_FILE!, "utf-8");
const userKpData = JSON.parse(userKpFile);
const userSecret = Uint8Array.from(userKpData);
const userKp = Keypair.fromSecretKey(userSecret);
const user = userKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const cancelRequestWithdrawVaultHandler = async () => {
  const ixs: TransactionInstruction[] = [];
  const cancelRequestWithdrawVaultIx =
    await vc.createCancelRequestWithdrawVaultIx({
      userTransferAuthority: user,
      vault,
    });
  ixs.push(cancelRequestWithdrawVaultIx);

  const txSig = await sendAndConfirmOptimisedTx(
    ixs,
    process.env.HELIUS_RPC_URL!,
    userKp
  );
  console.log("Cancel Request Withdraw Vault Tx Sig: ", txSig);
};

cancelRequestWithdrawVaultHandler();
