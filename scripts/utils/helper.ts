/**
 * Shared tx helpers for management scripts.
 * Adapted from voltrxyz/drift-scripts/src/utils/helper.ts
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionConfirmationStrategy,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

export const sendAndConfirmOptimisedTx = async (
  instructions: TransactionInstruction[],
  heliusRpcUrl: string,
  payerKp: Keypair,
  signers: Keypair[] = [],
  addressLookupTableAccounts: AddressLookupTableAccount[] = [],
  computeUnitLimit: number | null = null
): Promise<string> => {
  const connection = new Connection(heliusRpcUrl);
  let optimalCUs: number;

  if (computeUnitLimit) {
    optimalCUs = computeUnitLimit;
  } else {
    const testInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...instructions,
    ];
    const cuTx = new VersionedTransaction(
      new TransactionMessage({
        instructions: testInstructions,
        payerKey: payerKp.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      }).compileToV0Message(addressLookupTableAccounts)
    );
    cuTx.sign([payerKp, ...signers]);

    const sim = await connection.simulateTransaction(cuTx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    const used = sim.value.unitsConsumed;
    if (!used) throw new Error("Failed to simulate CU usage");
    optimalCUs = Math.ceil(used * 1.1);
  }

  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: optimalCUs })
  );

  const feTx = new VersionedTransaction(
    new TransactionMessage({
      instructions,
      payerKey: payerKp.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    }).compileToV0Message(addressLookupTableAccounts)
  );
  feTx.sign([payerKp, ...signers]);

  const resp = await fetch(heliusRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: bs58.encode(feTx.serialize()),
          options: { priorityLevel: "High" },
        },
      ],
    }),
  });
  const data = await resp.json() as any;
  const feeEstimate = data.result;
  if (!feeEstimate) throw new Error("Failed to get priority fee estimate");

  instructions.push(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: feeEstimate.priorityFeeEstimate,
    })
  );

  const tx = new VersionedTransaction(
    new TransactionMessage({
      instructions,
      payerKey: payerKp.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    }).compileToV0Message(addressLookupTableAccounts)
  );
  tx.sign([payerKp, ...signers]);

  const txSig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const strategy: TransactionConfirmationStrategy = {
    signature: txSig,
    blockhash,
    lastValidBlockHeight,
  };
  await connection.confirmTransaction(strategy, "confirmed");
  return txSig;
};

export const setupTokenAccount = async (
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  txIxs: TransactionInstruction[],
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> => {
  const tokenAccount = getAssociatedTokenAddressSync(mint, owner, true, programId);
  const info = await connection.getAccountInfo(tokenAccount);
  if (!info) {
    txIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        tokenAccount,
        owner,
        mint,
        programId
      )
    );
  }
  return tokenAccount;
};

export const getAddressLookupTableAccounts = async (
  keys: string[],
  connection: Connection
): Promise<AddressLookupTableAccount[]> => {
  const infos = await connection.getMultipleAccountsInfo(
    keys.map((k) => new PublicKey(k))
  );
  return infos.reduce((acc, info, i) => {
    if (info) {
      acc.push(
        new AddressLookupTableAccount({
          key: new PublicKey(keys[i]),
          state: AddressLookupTableAccount.deserialize(info.data),
        })
      );
    }
    return acc;
  }, new Array<AddressLookupTableAccount>());
};
