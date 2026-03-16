import { Connection, PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { heliusRpcUrl, vaultAddress } from "../variables";
import { fetchAllRaydiumClmmPositionsForVault } from "../utils/raydium";

const vault = new PublicKey(vaultAddress);

const connection = new Connection(heliusRpcUrl);
const vc = new VoltrClient(connection);

const queryAllInitStrategies = async () => {
  const vaultAccount = await vc.fetchVaultAccount(vault);
  const vaultTotalPosition = vaultAccount.asset.totalValue;
  console.log("vaultTotalPosition: ", vaultTotalPosition.toString());
  const allocations = await vc.fetchAllStrategyInitReceiptAccountsOfVault(
    vault
  );

  const allPosition = await fetchAllRaydiumClmmPositionsForVault(
    connection,
    vault
  );

  const filteredAllocations = allocations.filter((allocation) =>
    allPosition.some((p) => p.nftMint.equals(allocation.account.strategy))
  );

  filteredAllocations.forEach((allocation) => {
    console.log("Pk: ", allocation.publicKey.toBase58());
    console.log("Strategy: ", allocation.account.strategy.toBase58());
    console.log("amount: ", allocation.account.positionValue.toString());
  });
};

const main = async () => {
  await queryAllInitStrategies();
};

main();
