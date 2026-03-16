export interface DriftBearRebalancePlan {
  lendUsdcFraction: number;
  neutralLegFraction: number;
  action: "rebalance";
}

export async function driftbearRebalance(
  getVaultBalance: () => Promise<number>,
  depositToDriftLend: (amount: number) => Promise<void>,
  jupiterSwapUSDCtoSOL: (amount: number) => Promise<number>,
  openDriftShortPerp: (solAmount: number) => Promise<void>
): Promise<DriftBearRebalancePlan> {
  const vaultBalance = await getVaultBalance();
  const lendUsdcAmount = vaultBalance * 0.5;
  const neutralLegAmount = vaultBalance * 0.5;

  await depositToDriftLend(lendUsdcAmount);
  const swappedSol = await jupiterSwapUSDCtoSOL(neutralLegAmount);
  await openDriftShortPerp(swappedSol);

  return {
    action: "rebalance",
    lendUsdcFraction: 0.5,
    neutralLegFraction: 0.5,
  };
}
