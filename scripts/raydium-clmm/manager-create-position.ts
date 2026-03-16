import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import * as fs from "fs";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  adminFilePath,
  assetMintAddress,
  assetTokenProgram,
  endPrice,
  heliusRpcUrl,
  lookupTableAddress,
  outputMintAddress,
  outputTokenProgram,
  poolId,
  startPrice,
  useLookupTable,
  vaultAddress,
} from "../variables";
import { initSdk } from "../utils/raydium-config";
import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  getPdaExBitmapAccount,
  PoolUtils,
  TickUtils,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import { DISCRIMINATOR, RAYDIUM_ADAPTOR_PROGRAM_ID } from "../constants/global";
import { s32, struct } from "../utils/marshmallow";
import { fetchRaydiumClmmPoolPositionForVault } from "../utils/raydium";

const payerKpFile = fs.readFileSync(adminFilePath, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;
const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);
const vaultAssetTokenProgram = new PublicKey(assetTokenProgram);
const vaultOutputMint = new PublicKey(outputMintAddress);
const vaultOutputTokenProgram = new PublicKey(outputTokenProgram);

const connection = new Connection(heliusRpcUrl);
const vc = new VoltrClient(connection);

const createRaydiumCLMMPosition = async () => {
  const raydium = await initSdk();
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
  const assetMint = new PublicKey(assetMintAddress);
  const outputMint = new PublicKey(outputMintAddress);

  const [programId, id] = [
    new PublicKey(poolInfo.programId),
    new PublicKey(poolInfo.id),
  ];

  const isAssetToken0 = assetMint.toBuffer() < outputMint.toBuffer();

  const [startPriceCorrected, endPriceCorrected] = isAssetToken0
    ? [new Decimal(startPrice), new Decimal(endPrice)]
    : [new Decimal(1).div(endPrice), new Decimal(1).div(startPrice)];

  let { tick: lowerTick } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(startPriceCorrected),
    baseIn: isAssetToken0,
  });

  let { tick: upperTick } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(endPriceCorrected),
    baseIn: isAssetToken0,
  });

  [lowerTick, upperTick] =
    lowerTick > upperTick ? [upperTick, lowerTick] : [lowerTick, upperTick];

  const position = await fetchRaydiumClmmPoolPositionForVault(
    poolId,
    vault,
    connection,
    lowerTick,
    upperTick
  );

  if (position) throw new Error("Position already exists");

  const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(
    lowerTick,
    poolInfo.config.tickSpacing
  );
  const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(
    upperTick,
    poolInfo.config.tickSpacing
  );

  const { publicKey: tickArrayLower } = getPdaTickArrayAddress(
    programId,
    id,
    tickArrayLowerStartIndex
  );
  const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(
    programId,
    id,
    tickArrayUpperStartIndex
  );
  const nftMintAccountKp = Keypair.generate();
  const nftMintAccount = nftMintAccountKp.publicKey;

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(
    vault,
    nftMintAccount
  );

  const positionNftAccount = getAssociatedTokenAddressSync(
    nftMintAccount,
    vaultStrategyAuth,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const { publicKey: personalPosition } = getPdaPersonalPositionAddress(
    programId,
    nftMintAccount
  );
  const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(
    programId,
    id,
    lowerTick,
    upperTick
  );

  let transactionIxs: TransactionInstruction[] = [];

  const vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    payer,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultAssetTokenProgram
  );

  const vaultStrategyOutputAta = await setupTokenAccount(
    connection,
    payer,
    vaultOutputMint,
    vaultStrategyAuth,
    transactionIxs,
    vaultOutputTokenProgram
  );

  const [raydiumVaultAssetAta, raydiumVaultOutputAta] = isAssetToken0
    ? [new PublicKey(poolKeys.vault.A), new PublicKey(poolKeys.vault.B)]
    : [new PublicKey(poolKeys.vault.B), new PublicKey(poolKeys.vault.A)];

  const dataLayout = struct([
    s32("tickLowerIndex"),
    s32("tickUpperIndex"),
    s32("tickArrayLowerStartIndex"),
    s32("tickArrayUpperStartIndex"),
  ]);

  let additionalArgs = Buffer.alloc(dataLayout.span);
  dataLayout.encode(
    {
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
      tickArrayLowerStartIndex: tickArrayLowerStartIndex,
      tickArrayUpperStartIndex: tickArrayUpperStartIndex,
    },
    additionalArgs
  );

  additionalArgs = Buffer.from(additionalArgs);

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: Buffer.from(DISCRIMINATOR.OPEN_CLMM_POSITION),
      additionalArgs,
    },
    {
      payer,
      vault,
      manager: payer,
      strategy: nftMintAccount,
      adaptorProgram: new PublicKey(RAYDIUM_ADAPTOR_PROGRAM_ID),
      remainingAccounts: [
        { pubkey: CLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: nftMintAccount, isSigner: true, isWritable: true },
        { pubkey: positionNftAccount, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(poolId), isSigner: false, isWritable: true },
        { pubkey: protocolPosition, isSigner: false, isWritable: true },
        { pubkey: tickArrayLower, isSigner: false, isWritable: true },
        { pubkey: tickArrayUpper, isSigner: false, isWritable: true },
        { pubkey: personalPosition, isSigner: false, isWritable: true },
        { pubkey: vaultStrategyAssetAta, isSigner: false, isWritable: true },
        { pubkey: vaultStrategyOutputAta, isSigner: false, isWritable: true },
        { pubkey: raydiumVaultAssetAta, isSigner: false, isWritable: true },
        { pubkey: raydiumVaultOutputAta, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: vaultAssetMint, isSigner: false, isWritable: false },
        { pubkey: vaultOutputMint, isSigner: false, isWritable: false },
        ...(PoolUtils.isOverflowDefaultTickarrayBitmap(
          poolInfo.config.tickSpacing,
          [tickArrayLowerStartIndex, tickArrayUpperStartIndex]
        )
          ? [
              {
                pubkey: getPdaExBitmapAccount(
                  CLMM_PROGRAM_ID,
                  new PublicKey(poolId)
                ).publicKey,
                isSigner: false,
                isWritable: true,
              },
            ]
          : []),
      ],
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    heliusRpcUrl,
    payerKp,
    [nftMintAccountKp]
  );
  console.log("Raydium CLMM position created with signature:", txSig);

  if (useLookupTable) {
    let transactionIxs1: TransactionInstruction[] = [];
    await setupAddressLookupTable(
      connection,
      payer,
      payer,
      [
        ...new Set([
          ...createInitializeStrategyIx.keys.map((k) => k.pubkey.toBase58()),
          vaultStrategyAssetAta.toBase58(),
        ]),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      heliusRpcUrl,
      payerKp,
      []
    );

    console.log(`LUT created with signature: ${txSig1}`);
  }
};

const main = async () => {
  await createRaydiumCLMMPosition();
};

main();
