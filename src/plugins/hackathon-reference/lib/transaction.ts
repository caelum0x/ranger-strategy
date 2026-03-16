import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  TransactionConfirmationStrategy,
  TransactionInstruction,
  SendOptions,
  Commitment,
} from "@solana/web3.js";

export async function sendAndConfirmVersionedTransaction(
  connection: Connection,
  instructions: TransactionInstruction[],
  payerKeypair: Keypair,
  signers: Keypair[],
  sendOptions?: SendOptions,
  commitment: Commitment = "confirmed"
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const transaction = new VersionedTransaction(
    new TransactionMessage({
      instructions,
      payerKey: payerKeypair.publicKey,
      recentBlockhash: blockhash,
    }).compileToV0Message()
  );

  transaction.sign([payerKeypair, ...signers]);

  const defaultSendOptions: SendOptions = {
    skipPreflight: false,
    maxRetries: 5,
    ...sendOptions,
  };

  const txSig = await connection.sendTransaction(
    transaction,
    defaultSendOptions
  );

  const confirmationStrategy: TransactionConfirmationStrategy = {
    signature: txSig,
    blockhash,
    lastValidBlockHeight,
  };

  await connection.confirmTransaction(confirmationStrategy, commitment);

  return txSig;
}
