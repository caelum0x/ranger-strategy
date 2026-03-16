import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { vaultAddress } from "../../config/base";

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

const queryAllInitStrategies = async () => {
  const vaultAccount = await vc.fetchVaultAccount(vault);
  const vaultTotalPosition = vaultAccount.asset.totalValue;
  console.log("vaultTotalPosition: ", vaultTotalPosition.toString());
  const allocations = await vc.fetchAllStrategyInitReceiptAccountsOfVault(
    vault
  );

  allocations.forEach((allocation) => {
    console.log("Pk: ", allocation.publicKey.toBase58());
    console.log("Strategy: ", allocation.account.strategy.toBase58());
    console.log("amount: ", allocation.account.positionValue.toString());
  });
};

const main = async () => {
  await queryAllInitStrategies();
};

main();
