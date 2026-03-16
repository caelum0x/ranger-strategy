import { Connection, PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  PositionInfoLayout,
} from "@raydium-io/raydium-sdk-v2";

export const fetchRaydiumClmmPoolPositionForVault = async (
  poolId: string,
  vault: PublicKey,
  connection: Connection,
  lowerTick: number,
  upperTick: number
) => {
  const allPosition = await fetchAllRaydiumClmmPositionsForVault(
    connection,
    vault
  );

  const poolPositions = allPosition.filter(
    (p) => p.poolId.toBase58() === poolId
  );

  const position = poolPositions.find(
    (p) => p.tickLower === lowerTick && p.tickUpper === upperTick
  );

  return position;
};

export const fetchAllRaydiumClmmPositionsForVault = async (
  connection: Connection,
  vault: PublicKey
) => {
  const vc = new VoltrClient(connection);
  const initializedStrategies =
    await vc.fetchAllStrategyInitReceiptAccountsOfVault(vault);

  const vaultStrategyAuths = initializedStrategies.map((s) =>
    vc.findVaultStrategyAuth(vault, s.account.strategy)
  );

  const associatedTAs = initializedStrategies.map((s, idx) =>
    getAssociatedTokenAddressSync(
      s.account.strategy,
      vaultStrategyAuths[idx],
      true,
      TOKEN_2022_PROGRAM_ID
    )
  );

  const accountInfos = await connection.getMultipleAccountsInfo(associatedTAs);

  const validAssociatedTAs = accountInfos.filter(
    (a) =>
      a !== null &&
      unpackAccount(
        PublicKey.default,
        a,
        TOKEN_2022_PROGRAM_ID
      ).amount.toString() == "1"
  );

  const allPositionKey = validAssociatedTAs.map(
    (acc) =>
      getPdaPersonalPositionAddress(
        CLMM_PROGRAM_ID,
        unpackAccount(PublicKey.default, acc, TOKEN_2022_PROGRAM_ID).mint
      ).publicKey
  );

  const accountInfo = await connection.getMultipleAccountsInfo(allPositionKey);
  const allPosition: ReturnType<typeof PositionInfoLayout.decode>[] = [];
  accountInfo.forEach((positionRes) => {
    if (!positionRes) return;
    const position = PositionInfoLayout.decode(positionRes.data);
    allPosition.push(position);
  });
  return allPosition;
};
