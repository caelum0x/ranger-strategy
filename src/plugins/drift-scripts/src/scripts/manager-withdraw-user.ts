import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
  setupTokenAccount,
} from "../utils/helper";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  vaultAddress,
  assetTokenProgram,
  lookupTableAddress,
  useLookupTable,
} from "../../config/base";
import { withdrawStrategyAmount, driftMarketIndex } from "../../config/drift";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR, DRIFT } from "../constants/drift";
import { DriftClient, Wallet } from "@drift-labs/sdk";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);
const vaultAssetTokenProgram = new PublicKey(assetTokenProgram);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);
const withdrawAmount = new BN(withdrawStrategyAmount);

const withdrawDriftStrategy = async (
  protocolProgram: PublicKey,
  state: PublicKey,
  marketIndex: number,
  subAccountId: BN,
  lookupTableAddresses: string[] = []
) => {
  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  const [strategy] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_user")],
    new PublicKey(ADAPTOR_PROGRAM_ID)
  );

  const [driftSigner] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_signer")],
    protocolProgram
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, strategy);
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    protocolProgram
  );

  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      subAccountId.toArrayLike(Buffer, "le", 2),
    ],
    protocolProgram
  );

  let transactionIxs: TransactionInstruction[] = [];

  const _vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const driftClient = new DriftClient({
    connection,
    wallet: new Wallet(payerKp),
    env: "mainnet-beta",
    skipLoadUsers: true,
  });

  await driftClient.subscribe();

  // Prepare the remaining accounts
  const remainingAccounts = [
    { pubkey: driftSigner, isSigner: false, isWritable: true },
    { pubkey: counterPartyTa, isSigner: false, isWritable: true },
    { pubkey: protocolProgram, isSigner: false, isWritable: false },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: false, isWritable: true },
    { pubkey: state, isSigner: false, isWritable: false },
  ];

  const userAccounts = await driftClient.getUserAccountsForAuthority(
    vaultStrategyAuth
  );

  remainingAccounts.push(
    ...driftClient.getRemainingAccounts({
      userAccounts,
      useMarketLastSlotCache: false,
      writableSpotMarketIndexes: [marketIndex],
    })
  );

  await driftClient.unsubscribe();

  if (vaultAssetTokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    remainingAccounts.push({
      pubkey: vaultAssetMint,
      isSigner: false,
      isWritable: false,
    });
  }

  let additionalArgs = Buffer.from([
    ...new BN(marketIndex).toArrayLike(Buffer, "le", 2),
  ]);

  const createWithdrawStrategyIx = await vc.createWithdrawStrategyIx(
    {
      instructionDiscriminator: Buffer.from(DISCRIMINATOR.WITHDRAW_USER),
      withdrawAmount,
      additionalArgs,
    },
    {
      manager: payer,
      vault,
      vaultAssetMint,
      assetTokenProgram: vaultAssetTokenProgram,
      strategy,
      remainingAccounts,
      adaptorProgram: new PublicKey(ADAPTOR_PROGRAM_ID),
    }
  );

  transactionIxs.push(createWithdrawStrategyIx);

  const lookupTableAccounts = lookupTableAddresses
    ? await getAddressLookupTableAccounts(lookupTableAddresses, connection)
    : [];

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    [],
    lookupTableAccounts
  );
  console.log("Drift strategy withdrawed with signature:", txSig);
};

const main = async () => {
  await withdrawDriftStrategy(
    new PublicKey(DRIFT.PROGRAM_ID),
    new PublicKey(DRIFT.SPOT.STATE),
    driftMarketIndex,
    new BN(DRIFT.SUB_ACCOUNT_ID),
    useLookupTable
      ? [...DRIFT.LOOKUP_TABLE_ADDRESSES, lookupTableAddress]
      : [...DRIFT.LOOKUP_TABLE_ADDRESSES]
  );
};

main();
