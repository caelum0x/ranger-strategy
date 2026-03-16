// NOTE: THIS ONLY WORKS IF AND ONLY IF WITHDAWAL WAITING PERIOD IS 0
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
import { createCloseAccountInstruction, NATIVE_MINT } from "@solana/spl-token";
import { RequestWithdrawVaultArgs, VoltrClient } from "@voltr/vault-sdk";
import {
  vaultAddress,
  withdrawAmountVault,
  assetMintAddress,
  assetTokenProgram,
  isWithdrawInLp,
  isWithdrawAll,
} from "../../config/base";

const userKpFile = fs.readFileSync(process.env.USER_FILE_PATH!, "utf-8");
const userKpData = JSON.parse(userKpFile);
const userSecret = Uint8Array.from(userKpData);
const userKp = Keypair.fromSecretKey(userSecret);
const user = userKp.publicKey;

const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);
const vaultAssetTokenProgram = new PublicKey(assetTokenProgram);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);
const withdrawAmount = new BN(withdrawAmountVault);

const createrequestWithdrawVaultIxs = async (
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

  return ixs;
};

const createWithdrawVaultIxs = async () => {
  let ixs: TransactionInstruction[] = [];
  const userAssetAta = await setupTokenAccount(
    connection,
    user,
    vaultAssetMint,
    user,
    ixs,
    vaultAssetTokenProgram
  );

  const withdrawVaultIx = await vc.createWithdrawVaultIx({
    vault,
    userTransferAuthority: user,
    vaultAssetMint,
    assetTokenProgram: new PublicKey(assetTokenProgram),
  });
  ixs.push(withdrawVaultIx);

  if (vaultAssetMint.equals(NATIVE_MINT)) {
    // Create close account instruction to convert wSOL back to SOL
    const closeWsolAccountIx = createCloseAccountInstruction(
      userAssetAta, // Account to close
      user, // Destination account (SOL will be sent here)
      user, // Authority
      [] // No multisig signers
    );
    ixs.push(closeWsolAccountIx);
  }

  return ixs;
};

const requestAndWithdrawVaultHandler = async (
  withdrawAmount: BN,
  isAmountInLp: boolean,
  isWithdrawAll: boolean
) => {
  const requestWithdrawVaultIxs = await createrequestWithdrawVaultIxs(
    withdrawAmount,
    isAmountInLp,
    isWithdrawAll
  );
  const withdrawVaultIxs = await createWithdrawVaultIxs();
  const requestAndWithdrawVaultIxs = [
    ...requestWithdrawVaultIxs,
    ...withdrawVaultIxs,
  ];

  const txSig = await sendAndConfirmOptimisedTx(
    requestAndWithdrawVaultIxs,
    process.env.HELIUS_RPC_URL!,
    userKp
  );
  console.log("Request and Withdraw Vault Tx Sig: ", txSig);
};

requestAndWithdrawVaultHandler(withdrawAmount, isWithdrawInLp, isWithdrawAll);
