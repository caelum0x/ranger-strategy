// NOTE: ONLY ONE REQUEST WITHDRAWAL CAN BE MADE AT A TIME, WILL FAIL IF ANOTHER REQUEST WITHDRAWAL IS PENDING/NOT CLAIMED
import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { sendAndConfirmOptimisedTx, setupTokenAccount } from "../utils/helper";
import { RequestWithdrawVaultArgs, VoltrClient } from "@voltr/vault-sdk";
import {
  vaultAddress,
  withdrawAmountVault,
  isWithdrawInLp,
  isWithdrawAll,
} from "../../config/base";

const userKpFile = fs.readFileSync(process.env.USER_FILE_PATH!, "utf-8");
const userKpData = JSON.parse(userKpFile);
const userSecret = Uint8Array.from(userKpData);
const userKp = Keypair.fromSecretKey(userSecret);
const user = userKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);
const withdrawAmount = new BN(withdrawAmountVault);

const requestWithdrawVaultHandler = async (
  withdrawAmount: BN,
  isAmountInLp: boolean,
  isWithdrawAll: boolean
) => {
  const vaultLpMint = vc.findVaultLpMint(vault);
  const requestWithdrawVaultReceipt = vc.findRequestWithdrawVaultReceipt(
    vault,
    user
  );
  let ixs: TransactionInstruction[] = [];
  const _requestWithdrawLpAta = await setupTokenAccount(
    connection,
    user,
    vaultLpMint,
    requestWithdrawVaultReceipt,
    ixs
  );

  const requestWithdrawVaultArgs: RequestWithdrawVaultArgs = {
    amount: withdrawAmount,
    isAmountInLp,
    isWithdrawAll,
  };

  const requestWithdrawVaultIx = await vc.createRequestWithdrawVaultIx(
    requestWithdrawVaultArgs,
    {
      payer: user,
      userTransferAuthority: user,
      vault,
    }
  );
  ixs.push(requestWithdrawVaultIx);

  const txSig = await sendAndConfirmOptimisedTx(
    ixs,
    process.env.HELIUS_RPC_URL!,
    userKp
  );
  console.log("Request Withdraw Vault Tx Sig: ", txSig);
};

requestWithdrawVaultHandler(withdrawAmount, isWithdrawInLp, isWithdrawAll);
