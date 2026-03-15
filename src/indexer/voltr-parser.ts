import { VoltrClient } from "@voltr/vault-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { VaultSnapshot } from "./db";

export class VoltrVaultParser {
  private readonly client: VoltrClient;

  constructor(rpcUrl: string = config.solanaRpcUrl, client?: VoltrClient) {
    this.client = client || new VoltrClient(new Connection(rpcUrl, "confirmed"));
  }

  async parseVaultState(
    vaultAddress: string,
    sourceEvent?: VaultSnapshot["sourceEvent"]
  ): Promise<VaultSnapshot> {
    const vaultPubkey = new PublicKey(vaultAddress);
    const values = (await this.client.getPositionAndTotalValuesForVault(
      vaultPubkey
    )) as any;

    const [sharePrice, highWaterMark, adminFees, managerFees] = await Promise.all([
      this.safeRead(() => this.client.getCurrentAssetPerLpForVault(vaultPubkey)),
      this.safeRead(() => (this.client as any).getHighWaterMarkForVault?.(vaultPubkey)),
      this.safeRead(() => this.client.getAccumulatedAdminFeesForVault(vaultPubkey)),
      this.safeRead(() => this.client.getAccumulatedManagerFeesForVault(vaultPubkey)),
    ]);

    return {
      vault: vaultPubkey.toBase58(),
      aum: this.toStringValue(values?.totalValue ?? 0) || "0",
      sharePrice: this.toStringValue(sharePrice),
      highWaterMark: this.toStringValue(highWaterMark),
      strategyPositions: Array.isArray(values?.strategies) ? values.strategies : [],
      fees: {
        admin: this.toStringValue(adminFees),
        manager: this.toStringValue(managerFees),
      },
      sourceEvent: sourceEvent || { type: "manual-sync" },
      timestamp: Date.now(),
    };
  }

  private async safeRead<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }

  private toStringValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") {
      return value.toString();
    }
    if (typeof (value as any).toString === "function") {
      return (value as any).toString();
    }
    return undefined;
  }
}
