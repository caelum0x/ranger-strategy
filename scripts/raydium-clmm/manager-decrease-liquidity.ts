import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
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
  poolId,
  endPrice,
  startPrice,
  assetTokenOracle,
  outputTokenOracle,
  decreaseLiquidityAssetAmount,
} from "../variables";
import { setupJupiterSwapForWithdrawStrategy } from "../utils/setup-jupiter-swap";
import { initSdk } from "../utils/raydium-config";
import {
  CLMM_PROGRAM_ID,
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  MEMO_PROGRAM_ID,
  PoolUtils,
  PositionUtils,
  TickArrayLayout,
  TickUtils,
} from "@raydium-io/raydium-sdk-v2";
import { Decimal } from "decimal.js";
import { DISCRIMINATOR, RAYDIUM_ADAPTOR_PROGRAM_ID } from "../constants/global";
import { fetchRaydiumClmmPoolPositionForVault } from "../utils/raydium";
import { SYSTEM_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/native/system";

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
const decreaseLiquidityAmount = new BN(decreaseLiquidityAssetAmount);

const decreaseRaydiumCLMMLiquidity = async () => {
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

  // Prepare the remaining accounts
  const remainingAccounts = [
    { pubkey: CLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: positionNftAccount, isSigner: false, isWritable: true },
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
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: vaultAssetOracle, isSigner: false, isWritable: false },
    { pubkey: vaultOutputOracle, isSigner: false, isWritable: false },
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
  ];

  for (let i = 0; i < poolKeys.rewardInfos.length; i++) {
    const poolRewardVault = new PublicKey(poolKeys.rewardInfos[i].vault);
    const rewardMint = new PublicKey(poolKeys.rewardInfos[i].mint.address);
    const rewardProgram = new PublicKey(poolKeys.rewardInfos[i].mint.programId);
    const ownerRewardVault = await setupTokenAccount(
      connection,
      payer,
      rewardMint,
      vaultStrategyAuth,
      transactionIxs,
      rewardProgram
    );

    remainingAccounts.push(
      {
        pubkey: poolRewardVault,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: ownerRewardVault,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: rewardMint,
        isSigner: false,
        isWritable: false,
      }
    );
  }

  const baseAddressLookupTableAddresses: string[] = [];

  if (poolKeys.lookupTableAccount)
    baseAddressLookupTableAddresses.push(poolKeys.lookupTableAccount);

  if (useLookupTable) baseAddressLookupTableAddresses.push(lookupTableAddress);

  const strategyInitReceipt = vc.findStrategyInitReceipt(vault, nftMintAccount);
  const strategy = await vc.fetchStrategyInitReceiptAccount(
    strategyInitReceipt
  );
  const ratioToDecrease = Math.min(
    1.0,
    decreaseLiquidityAmount.toNumber() / strategy.positionValue.toNumber()
  );

  const { amountA, amountB } = PositionUtils.getAmountsFromLiquidity({
    poolInfo,
    ownerPosition: position,
    liquidity: position.liquidity,
    slippage: 0,
    add: false,
    epochInfo: await connection.getEpochInfo(),
  });

  const expectedOutputPositionAmount =
    (isAssetToken0 ? amountB : amountA).amount.toNumber() * ratioToDecrease;

  const rpcPoolData = await raydium.clmm.getRpcClmmPoolInfo({
    poolId: position.poolId,
  });

  const tickArrayRes = await raydium.connection.getMultipleAccountsInfo([
    tickArrayLower,
    tickArrayUpper,
  ]);

  if (!tickArrayRes[0] || !tickArrayRes[1])
    throw new Error("tick data not found");
  const tickArrayLowerDecoded = TickArrayLayout.decode(tickArrayRes[0].data);
  const tickArrayUpperDecoded = TickArrayLayout.decode(tickArrayRes[1].data);
  const tickLowerState =
    tickArrayLowerDecoded.ticks[
      TickUtils.getTickOffsetInArray(
        position.tickLower,
        poolInfo.config.tickSpacing
      )
    ];

  const tickUpperState =
    tickArrayUpperDecoded.ticks[
      TickUtils.getTickOffsetInArray(
        position.tickUpper,
        poolInfo.config.tickSpacing
      )
    ];

  const tokenFees = PositionUtils.GetPositionFeesV2(
    rpcPoolData,
    position,
    tickLowerState,
    tickUpperState
  );

  const expectedOutputFeeAmount = isAssetToken0
    ? tokenFees.tokenFeeAmountB.gte(new BN(0))
      ? tokenFees.tokenFeeAmountB
      : new BN(0)
    : tokenFees.tokenFeeAmountA.gte(new BN(0))
    ? tokenFees.tokenFeeAmountA
    : new BN(0);

  const expectedOutputAmount = new BN(expectedOutputPositionAmount)
    .add(expectedOutputFeeAmount)
    .mul(new BN(99))
    .div(new BN(100));

  const { additionalArgs, addressLookupTableAccounts } =
    await setupJupiterSwapForWithdrawStrategy(
      connection,
      expectedOutputAmount,
      new BN(0),
      payer,
      vaultStrategyAuth,
      Buffer.from([]),
      remainingAccounts,
      transactionIxs,
      baseAddressLookupTableAddresses
    );

  if (ratioToDecrease === 1.0 || position.liquidity.isZero()) {
    remainingAccounts.push({
      pubkey: nftMintAccount,
      isSigner: false,
      isWritable: true,
    });
    remainingAccounts.push({
      pubkey: payer,
      isSigner: false,
      isWritable: true,
    });
    remainingAccounts.push({
      pubkey: SYSTEM_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    });
  }

  const createWithdrawStrategyIx = await vc.createWithdrawStrategyIx(
    {
      withdrawAmount: decreaseLiquidityAmount,
      instructionDiscriminator: Buffer.from(
        DISCRIMINATOR.DECREASE_CLMM_LIQUIDITY
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

  transactionIxs.push(createWithdrawStrategyIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    heliusRpcUrl,
    payerKp,
    [],
    addressLookupTableAccounts
  );
  console.log("Raydium CLMM liquidity decreased with signature:", txSig);
};

const main = async () => {
  await decreaseRaydiumCLMMLiquidity();
};

main();
