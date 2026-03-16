import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { sendAndConfirmOptimisedTx, setupTokenAccount } from "../utils/helper";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  heliusRpcUrl,
  managerFilePath,
  vaultAddress,
  assetTokenProgram,
  outputMintAddress,
  outputTokenProgram,
  lookupTableAddress,
  useLookupTable,
  increaseLiquidityAssetAmount,
  poolId,
  endPrice,
  startPrice,
  assetTokenOracle,
  outputTokenOracle,
} from "../variables";
import { setupJupiterSwapForDepositStrategy } from "../utils/setup-jupiter-swap";
import { initSdk } from "../utils/raydium-config";
import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  getPdaExBitmapAccount,
  MEMO_PROGRAM_ID,
  PoolUtils,
  TickUtils,
} from "@raydium-io/raydium-sdk-v2";
import { Decimal } from "decimal.js";
import { DISCRIMINATOR, RAYDIUM_ADAPTOR_PROGRAM_ID } from "../constants/global";
import { fetchRaydiumClmmPoolPositionForVault } from "../utils/raydium";

const payerKpFile = fs.readFileSync(managerFilePath, "utf-8");
const payerKpData = JSON.parse(payerKpFile);
const payerSecret = Uint8Array.from(payerKpData);
const payerKp = Keypair.fromSecretKey(payerSecret);
const payer = payerKp.publicKey;

const vault = new PublicKey(vaultAddress);
const vaultAssetMint = new PublicKey(assetMintAddress);
const vaultAssetTokenProgram = new PublicKey(assetTokenProgram);
const vaultAssetOracle = new PublicKey(assetTokenOracle);
const vaultOutputMint = new PublicKey(outputMintAddress);
const vaultOutputTokenProgram = new PublicKey(outputTokenProgram);
const vaultOutputOracle = new PublicKey(outputTokenOracle);

const connection = new Connection(heliusRpcUrl);
const vc = new VoltrClient(connection);
const increaseLiquidityAmount = new BN(increaseLiquidityAssetAmount);

const increaseRaydiumCLMMLiquidity = async () => {
  const raydium = await initSdk();
  const { poolInfo, poolKeys, computePoolInfo, tickData } =
    await raydium.clmm.getPoolInfoFromRpc(poolId);
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
    baseIn: true,
  });

  let { tick: upperTick } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(endPriceCorrected),
    baseIn: true,
  });

  let { price: lowerTickPrice } = TickUtils.getTickPrice({
    poolInfo,
    tick: lowerTick,
    baseIn: true,
  });

  let { price: upperTickPrice } = TickUtils.getTickPrice({
    poolInfo,
    tick: upperTick,
    baseIn: true,
  });

  const position = await fetchRaydiumClmmPoolPositionForVault(
    poolId,
    vault,
    connection,
    lowerTick,
    upperTick
  );

  if (!position) throw new Error("Position not yet created");

  const nftMintAccount = position?.nftMint;

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

  const currentPrice = new Decimal(poolInfo.price);
  const tickPriceRange = upperTickPrice.minus(lowerTickPrice);
  const lhsRatio = currentPrice.sub(lowerTickPrice).div(tickPriceRange);
  const rhsRatio = upperTickPrice.sub(currentPrice).div(tickPriceRange);
  const assetRatioToSwap = isAssetToken0 ? lhsRatio : rhsRatio;
  const assetAmountToSwap = new BN(
    new Decimal(increaseLiquidityAmount.toString())
      .mul(assetRatioToSwap)
      .mul(1.01)
      .toNumber()
  );

  const outputDecimals = await getMint(connection, outputMint).then(
    (mint) => mint.decimals
  );

  const assetDecimals = await getMint(connection, assetMint).then(
    (mint) => mint.decimals
  );

  const currentOutputPerAssetPrice = isAssetToken0
    ? currentPrice
    : new Decimal(1).div(currentPrice);

  const expectedOutputAmount = new BN(
    new Decimal(assetAmountToSwap.toString())
      .div(new Decimal(10).pow(assetDecimals))
      .mul(currentOutputPerAssetPrice)
      .mul(new Decimal(10).pow(outputDecimals))
      .floor()
      .toString()
  );

  let transactionIxs: TransactionInstruction[] = [];

  const { remainingAccounts: raydiumRemainingAccounts } =
    PoolUtils.computeAmountOutFormat({
      poolInfo: computePoolInfo,
      tickArrayCache: tickData[poolId],
      amountIn: expectedOutputAmount,
      tokenOut: poolInfo[isAssetToken0 ? "mintB" : "mintA"],
      slippage: 0.01,
      epochInfo: await raydium.fetchEpochInfo(),
    });

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

  const { vaultAssetIdleAuth } = vc.findVaultAddresses(vault);
  const vaultAssetIdleAta = getAssociatedTokenAddressSync(
    vaultAssetMint,
    vaultAssetIdleAuth,
    true,
    vaultAssetTokenProgram
  );

  // Prepare the remaining accounts
  const remainingAccounts = [
    { pubkey: CLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: positionNftAccount, isSigner: false, isWritable: false },
    { pubkey: id, isSigner: false, isWritable: true },
    { pubkey: protocolPosition, isSigner: false, isWritable: true },
    { pubkey: personalPosition, isSigner: false, isWritable: true },
    { pubkey: tickArrayLower, isSigner: false, isWritable: true },
    { pubkey: tickArrayUpper, isSigner: false, isWritable: true },
    { pubkey: vaultStrategyOutputAta, isSigner: false, isWritable: true },
    { pubkey: raydiumVaultAssetAta, isSigner: false, isWritable: true },
    { pubkey: raydiumVaultOutputAta, isSigner: false, isWritable: true },
    { pubkey: vaultOutputMint, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultAssetOracle, isSigner: false, isWritable: false },
    { pubkey: vaultOutputOracle, isSigner: false, isWritable: false },
    {
      pubkey: new PublicKey(poolInfo.config.id),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: new PublicKey(poolKeys.observationId),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultAssetIdleAta, isSigner: false, isWritable: true },
  ];

  const baseAddressLookupTableAddresses: string[] = [];

  if (poolKeys.lookupTableAccount)
    baseAddressLookupTableAddresses.push(poolKeys.lookupTableAccount);

  if (useLookupTable) baseAddressLookupTableAddresses.push(lookupTableAddress);

  const { additionalArgs, addressLookupTableAccounts } =
    await setupJupiterSwapForDepositStrategy(
      connection,
      assetAmountToSwap,
      new BN(0),
      payer,
      vaultStrategyAuth,
      Buffer.from([]),
      remainingAccounts,
      transactionIxs,
      baseAddressLookupTableAddresses
    );

  remainingAccounts.push({
    pubkey: getPdaExBitmapAccount(CLMM_PROGRAM_ID, new PublicKey(poolId))
      .publicKey,
    isSigner: false,
    isWritable: true,
  });

  remainingAccounts.push(
    ...raydiumRemainingAccounts.map((pk) => ({
      pubkey: new PublicKey(pk),
      isSigner: false,
      isWritable: true,
    }))
  );

  const createDepositStrategyIx = await vc.createDepositStrategyIx(
    {
      depositAmount: increaseLiquidityAmount,
      instructionDiscriminator: Buffer.from(
        DISCRIMINATOR.INCREASE_CLMM_LIQUIDITY
      ),
      additionalArgs: additionalArgs.length > 0 ? additionalArgs : null,
    },
    {
      manager: payer,
      vault,
      vaultAssetMint,
      assetTokenProgram: new PublicKey(assetTokenProgram),
      strategy: nftMintAccount,
      adaptorProgram: new PublicKey(RAYDIUM_ADAPTOR_PROGRAM_ID),
      remainingAccounts,
    }
  );

  transactionIxs.push(createDepositStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    heliusRpcUrl,
    payerKp,
    [],
    addressLookupTableAccounts
  );
  console.log("Raydium CLMM liquidity increased with signature:", txSig);
};

const main = async () => {
  await increaseRaydiumCLMMLiquidity();
};

main();
