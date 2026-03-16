import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  assetMintAddress,
  JUP_SWAP_MAX_ACCOUNTS,
  JUP_SWAP_SLIPPAGE_BPS,
  outputMintAddress,
  outputTokenProgram,
} from "../variables";
import { ORACLE } from "../constants/global";
import BN from "bn.js";
import { setupTokenAccount } from "./helper";

const JUP_ENDPOINT = "https://lite-api.jup.ag/swap/v1";

export const setupJupiterSwapForDepositStrategy = async (
  connection: Connection,
  amount: BN,
  minimumThresholdAmountOut: BN,
  payer: PublicKey,
  vaultStrategyAuth: PublicKey,
  additionalArgsBase: Buffer,
  remainingAccounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[],
  txIxs: TransactionInstruction[],
  baseAddressLookupTableAddresses: string[]
) => {
  return setupJupiterSwap(
    connection,
    amount,
    amount,
    minimumThresholdAmountOut,
    payer,
    vaultStrategyAuth,
    additionalArgsBase,
    remainingAccounts,
    txIxs,
    baseAddressLookupTableAddresses,
    true
  );
};

export const setupJupiterSwapForWithdrawStrategy = async (
  connection: Connection,
  amount: BN,
  minimumThresholdAmountOut: BN,
  payer: PublicKey,
  vaultStrategyAuth: PublicKey,
  additionalArgsBase: Buffer,
  remainingAccounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[],
  txIxs: TransactionInstruction[],
  baseAddressLookupTableAddresses: string[]
) => {
  return setupJupiterSwap(
    connection,
    amount,
    amount,
    minimumThresholdAmountOut,
    payer,
    vaultStrategyAuth,
    additionalArgsBase,
    remainingAccounts,
    txIxs,
    baseAddressLookupTableAddresses,
    false
  );
};

export async function setupJupiterSwap(
  connection: Connection,
  amount: BN,
  swapAmount: BN,
  minimumThresholdAmountOut: BN,
  payer: PublicKey,
  vaultStrategyAuth: PublicKey,
  additionalArgsBase: Buffer,
  remainingAccounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[],
  txIxs: TransactionInstruction[],
  baseAddressLookupTableAddresses: string[],
  isDeposit: boolean = true
): Promise<{
  addressLookupTableAccounts: AddressLookupTableAccount[];
  additionalArgs: Buffer;
}> {
  const slippageBps = JUP_SWAP_SLIPPAGE_BPS;
  const maxAccounts = JUP_SWAP_MAX_ACCOUNTS;

  let additionalArgs = additionalArgsBase;

  const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

  const _vaultStrategyOutputAta = await setupTokenAccount(
    connection,
    payer,
    new PublicKey(outputMintAddress),
    vaultStrategyAuth,
    txIxs,
    new PublicKey(outputTokenProgram)
  );

  addressLookupTableAccounts.push(
    ...(await getAddressLookupTableAccounts(
      [...baseAddressLookupTableAddresses],
      connection
    ))
  );

  if (amount && amount.gt(new BN(0))) {
    try {
      // Get Jupiter quote
      const jupQuoteResponse = await (
        await fetch(
          `${JUP_ENDPOINT}/quote?inputMint=` +
            `${isDeposit ? assetMintAddress : outputMintAddress}` +
            `&outputMint=` +
            `${isDeposit ? outputMintAddress : assetMintAddress}` +
            `&amount=` +
            `${swapAmount.toString()}` +
            `&slippageBps=` +
            `${isDeposit ? slippageBps : 10_000}` +
            `&maxAccounts=` +
            `${maxAccounts}`
        )
      ).json();

      if (
        new BN(jupQuoteResponse.otherAmountThreshold).lt(
          minimumThresholdAmountOut
        )
      )
        throw new Error("Jupiter swap amount is too low");

      // Get Jupiter swap instructions
      const instructions = await (
        await fetch(`${JUP_ENDPOINT}/swap-instructions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            quoteResponse: jupQuoteResponse,
            userPublicKey: vaultStrategyAuth.toBase58(),
            useTokenLedger: !isDeposit,
          }),
        })
      ).json();

      if (instructions.error) {
        throw new Error(
          "Failed to get swap instructions: " + instructions.error
        );
      }

      // tokenLedgerInstruction is only present in withdrawals
      const {
        tokenLedgerInstruction: tokenLedgerPayload,
        swapInstruction: swapInstructionPayload,
        addressLookupTableAddresses,
      } = instructions;

      if (!isDeposit) {
        const tokenLedgerInstruction = new TransactionInstruction({
          programId: new PublicKey(tokenLedgerPayload.programId),
          keys: tokenLedgerPayload.accounts.map((key: any) => ({
            pubkey: new PublicKey(key.pubkey),
            isSigner: key.isSigner,
            isWritable: key.isWritable,
          })),
          data: Buffer.from(tokenLedgerPayload.data, "base64"),
        });

        txIxs.push(tokenLedgerInstruction);
      }

      // Get address lookup table accounts
      addressLookupTableAccounts.push(
        ...(await getAddressLookupTableAccounts(
          [...baseAddressLookupTableAddresses, ...addressLookupTableAddresses],
          connection
        ))
      );

      remainingAccounts.push(
        {
          pubkey: new PublicKey(swapInstructionPayload.programId),
          isSigner: false,
          isWritable: false,
        },
        ...swapInstructionPayload.accounts.map((key: any) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: false,
          isWritable: key.isWritable,
        }))
      );
      // Combine base data with Jupiter swap data
      if (!isDeposit) {
        const withdrawData = Buffer.from([
          ...new BN(jupQuoteResponse.inAmount).toArrayLike(Buffer, "le", 8),
          ...new BN(jupQuoteResponse.outAmount).toArrayLike(Buffer, "le", 8),
          ...new BN(slippageBps).toArrayLike(Buffer, "le", 2),
        ]);

        const bufferLength = additionalArgs.length + withdrawData.length;

        additionalArgs = Buffer.concat(
          [additionalArgs, withdrawData],
          bufferLength
        );
      }

      const jupSwapData = Buffer.from(swapInstructionPayload.data, "base64");
      const bufferLength = additionalArgs.length + jupSwapData.length;
      additionalArgs = Buffer.concat(
        [additionalArgs, jupSwapData],
        bufferLength
      );
    } catch (error) {
      console.error("Error setting up Jupiter swap:", error);
      throw error;
    }
  }

  return {
    addressLookupTableAccounts,
    additionalArgs,
  };
}

const getPythPrice = async (mint: PublicKey) => {
  const pythFeedId = Object.values(ORACLE).find(
    (oracle) => oracle.MINT === mint.toBase58()
  )?.PYTH_FEED_ID;
  const pythPriceResponse = await fetch(
    `https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=${pythFeedId}`
  );
  const pythPriceData = await pythPriceResponse.json();
  const pythPriceParsed = pythPriceData.parsed[0];
  const pythPrice =
    pythPriceParsed.price.price * Math.pow(10, pythPriceParsed.price.expo);
  return pythPrice;
};

const getAddressLookupTableAccounts = async (
  keys: string[],
  connection: Connection
): Promise<AddressLookupTableAccount[]> => {
  const addressLookupTableAccountInfos =
    await connection.getMultipleAccountsInfo(
      keys.map((key) => new PublicKey(key))
    );

  return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
    const addressLookupTableAddress = keys[index];
    if (accountInfo) {
      const addressLookupTableAccount = new AddressLookupTableAccount({
        key: new PublicKey(addressLookupTableAddress),
        state: AddressLookupTableAccount.deserialize(accountInfo.data),
      });
      acc.push(addressLookupTableAccount);
    }
    return acc;
  }, new Array<AddressLookupTableAccount>());
};
