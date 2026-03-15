import { PublicKey, AccountMeta } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
const DRIFT_STATE = new PublicKey(
  "5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN"
);
const POSITION_SEED = Buffer.from("driftbear-position");
const STRATEGY_SEED = Buffer.from("driftbear-strategy");
const DRIFT_SIGNER_SEED = Buffer.from("drift_signer");
const SPOT_MARKET_SEED = Buffer.from("spot_market");
const SPOT_MARKET_VAULT_SEED = Buffer.from("spot_market_vault");

export function deriveDriftBearStrategy(
  adaptorProgram: PublicKey,
  vault: PublicKey,
  marketIndex: number
): PublicKey {
  const [strategy] = PublicKey.findProgramAddressSync(
    [
      STRATEGY_SEED,
      vault.toBuffer(),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    adaptorProgram
  );
  return strategy;
}

export function deriveDriftBearPosition(
  adaptorProgram: PublicKey,
  strategy: PublicKey
): PublicKey {
  const [position] = PublicKey.findProgramAddressSync(
    [POSITION_SEED, strategy.toBuffer()],
    adaptorProgram
  );
  return position;
}

export function deriveDriftUserAccounts(
  authority: PublicKey,
  subAccountId: number
): { user: PublicKey; userStats: PublicKey } {
  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      authority.toBuffer(),
      new BN(subAccountId).toArrayLike(Buffer, "le", 2),
    ],
    DRIFT_PROGRAM_ID
  );
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), authority.toBuffer()],
    DRIFT_PROGRAM_ID
  );

  return { user, userStats };
}

export function deriveDriftSpotAccounts(marketIndex: number): {
  spotMarket: PublicKey;
  spotMarketVault: PublicKey;
  driftSigner: PublicKey;
} {
  const marketSeed = new BN(marketIndex).toArrayLike(Buffer, "le", 2);
  const [spotMarket] = PublicKey.findProgramAddressSync(
    [SPOT_MARKET_SEED, marketSeed],
    DRIFT_PROGRAM_ID
  );
  const [spotMarketVault] = PublicKey.findProgramAddressSync(
    [SPOT_MARKET_VAULT_SEED, marketSeed],
    DRIFT_PROGRAM_ID
  );
  const [driftSigner] = PublicKey.findProgramAddressSync(
    [DRIFT_SIGNER_SEED],
    DRIFT_PROGRAM_ID
  );

  return { spotMarket, spotMarketVault, driftSigner };
}

export function buildDriftBearInitializeRemainingAccounts(params: {
  adaptorProgram: PublicKey;
  strategy: PublicKey;
  vaultStrategyAuth: PublicKey;
  marketIndex: number;
  subAccountId: number;
}): AccountMeta[] {
  const { adaptorProgram, strategy, vaultStrategyAuth, marketIndex, subAccountId } =
    params;
  const position = deriveDriftBearPosition(adaptorProgram, strategy);
  const { user, userStats } = deriveDriftUserAccounts(
    vaultStrategyAuth,
    subAccountId
  );

  return [
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: DRIFT_STATE, isSigner: false, isWritable: false },
    { pubkey: user, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    {
      pubkey: deriveDriftSpotAccounts(marketIndex).spotMarket,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

export function buildDriftBearDepositRemainingAccounts(params: {
  adaptorProgram: PublicKey;
  strategy: PublicKey;
  vaultStrategyAuth: PublicKey;
  marketIndex: number;
  subAccountId: number;
}): AccountMeta[] {
  const { adaptorProgram, strategy, vaultStrategyAuth, marketIndex, subAccountId } =
    params;
  const position = deriveDriftBearPosition(adaptorProgram, strategy);
  const { user, userStats } = deriveDriftUserAccounts(
    vaultStrategyAuth,
    subAccountId
  );
  const { spotMarket, spotMarketVault } = deriveDriftSpotAccounts(marketIndex);

  return [
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: DRIFT_STATE, isSigner: false, isWritable: false },
    { pubkey: user, isSigner: false, isWritable: true },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: spotMarket, isSigner: false, isWritable: false },
    { pubkey: spotMarketVault, isSigner: false, isWritable: true },
    { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

export function buildDriftBearWithdrawRemainingAccounts(params: {
  adaptorProgram: PublicKey;
  strategy: PublicKey;
  vaultStrategyAuth: PublicKey;
  marketIndex: number;
  subAccountId: number;
}): AccountMeta[] {
  const base = buildDriftBearDepositRemainingAccounts(params);
  const { driftSigner } = deriveDriftSpotAccounts(params.marketIndex);
  return [
    ...base.slice(0, 6),
    { pubkey: driftSigner, isSigner: false, isWritable: false },
    base[6],
  ];
}

