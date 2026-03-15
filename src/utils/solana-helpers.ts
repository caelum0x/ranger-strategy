/**
 * Shared Solana transaction utilities for runtime code.
 * Mirrors scripts/utils/helper.ts (adapted from voltrxyz/drift-scripts).
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
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
  const defaultCUs = 1_400_000;
  let optimalCUs: number = defaultCUs;

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

    try {
      const sim = await connection.simulateTransaction(cuTx, {
        replaceRecentBlockhash: true,
        sigVerify: false,
      });
      const used = sim.value.unitsConsumed;
      if (used) {
        optimalCUs = Math.ceil(used * 1.1);
      }
    } catch (error) {
      console.warn("CU simulation failed; falling back to default CU limit", error);
    }
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

  try {
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
    const data = (await resp.json()) as any;
    const feeEstimate = data?.result?.priorityFeeEstimate;
    if (feeEstimate) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: feeEstimate,
        })
      );
    }
  } catch (error) {
    console.warn("Priority fee estimate failed; continuing without it", error);
  }

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
