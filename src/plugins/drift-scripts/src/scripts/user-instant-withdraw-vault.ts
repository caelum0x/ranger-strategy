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
import { InstantWithdrawVaultArgs, VoltrClient } from "@voltr/vault-sdk";
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

const createInstantWithdrawVaultIxs = async (
  withdrawAmount: BN,
  isAmountInLp: boolean,
  isWithdrawAll: boolean
) => {
  let ixs: TransactionInstruction[] = [];
  const userAssetAta = await setupTokenAccount(
    connection,
    user,
    vaultAssetMint,
    user,
    ixs,
    vaultAssetTokenProgram
  );

  const instantWithdrawVaultArgs: InstantWithdrawVaultArgs = {
    amount: withdrawAmount,
    isAmountInLp,
    isWithdrawAll,
  };

  const instantWithdrawVaultIx = await vc.createInstantWithdrawVaultIx(
    instantWithdrawVaultArgs,
    {
      userTransferAuthority: user,
      vault,
      vaultAssetMint,
      assetTokenProgram: vaultAssetTokenProgram,
    }
  );
  ixs.push(instantWithdrawVaultIx);

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

const instantWithdrawVaultHandler = async (
  withdrawAmount: BN,
  isAmountInLp: boolean,
  isWithdrawAll: boolean
) => {
  const instantWithdrawVaultIxs = await createInstantWithdrawVaultIxs(
    withdrawAmount,
    isAmountInLp,
    isWithdrawAll
  );

  const txSig = await sendAndConfirmOptimisedTx(
    instantWithdrawVaultIxs,
    process.env.HELIUS_RPC_URL!,
    userKp
  );
  console.log("Instant Withdraw Vault Tx Sig: ", txSig);
};

instantWithdrawVaultHandler(withdrawAmount, isWithdrawInLp, isWithdrawAll);
