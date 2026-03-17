/**
 * Raydium pool creation — CLMM, CPMM, and AMM V4.
 *
 * Ported from raydium-plugin:
 *   - raydium_create_clmm.ts (concentrated liquidity)
 *   - raydium_create_cpmm.ts (constant product)
 *   - raydium_create_ammV4.ts (legacy AMM V4)
 *
 * Uses @raydium-io/raydium-sdk-v2 for pool creation.
 * Used by: Raydium LP strategy for creating new pools or positions.
 */
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";
import BN from "bn.js";
import Decimal from "decimal.js";
import { logger } from "../utils/logger";

// ── Types ───────────────────────────────────────────────────────

export interface PoolCreationResult {
  txSignature: string;
  poolAddress?: string;
}

interface MintFormatInfo {
  chainId: number;
  address: string;
  programId: string;
  logoURI: string;
  symbol: string;
  name: string;
  decimals: number;
  tags: string[];
  extensions: Record<string, unknown>;
}

// ── Raydium Client ──────────────────────────────────────────────

export class RaydiumClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Fetch and decode mint info for pool creation.
   * From: raydium-plugin (shared pattern across all pool types).
   */
  private async fetchMintInfo(mint: PublicKey): Promise<MintFormatInfo> {
    const accountInfo = await this.connection.getAccountInfo(mint);
    if (!accountInfo) throw new Error(`Mint ${mint.toBase58()} not found`);

    const decoded = MintLayout.decode(accountInfo.data);
    return {
      chainId: 101, // mainnet
      address: mint.toBase58(),
      programId: accountInfo.owner.toBase58(),
      logoURI: "",
      symbol: "",
      name: "",
      decimals: decoded.decimals,
      tags: [],
      extensions: {},
    };
  }

  /**
   * Create a Raydium CLMM (Concentrated Liquidity) pool.
   * From: raydium-plugin/raydium_create_clmm.ts
   *
   * Uses @raydium-io/raydium-sdk-v2 for real pool creation.
   */
  async createCLMMPool(params: {
    mint1: PublicKey;
    mint2: PublicKey;
    configId: PublicKey;
    initialPrice: Decimal;
    startTime: BN;
    signer: Keypair;
  }): Promise<string> {
    try {
      // Dynamic import to avoid requiring SDK when not used
      const { Raydium, CLMM_PROGRAM_ID, TxVersion } = await import(
        "@raydium-io/raydium-sdk-v2"
      );

      const raydium = await Raydium.load({ connection: this.connection });

      const mintInfo1 = await this.fetchMintInfo(params.mint1);
      const mintInfo2 = await this.fetchMintInfo(params.mint2);

      const { transaction } = await raydium.clmm.createPool({
        programId: CLMM_PROGRAM_ID,
        mint1: mintInfo1,
        mint2: mintInfo2,
        ammConfig: { id: params.configId } as any,
        initialPrice: params.initialPrice,
        startTime: params.startTime,
        txVersion: TxVersion.V0,
      });

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.message.recentBlockhash = blockhash;
      transaction.sign([params.signer]);

      const txSig = await this.connection.sendTransaction(transaction);
      logger.info("Raydium: CLMM pool created", { txSig });
      return txSig;
    } catch (err) {
      logger.warn("Raydium CLMM pool creation failed", { error: String(err) });
      throw err;
    }
  }

  /**
   * Create a Raydium CPMM (Constant Product) pool.
   * From: raydium-plugin/raydium_create_cpmm.ts
   */
  async createCPMMPool(params: {
    mintA: PublicKey;
    mintB: PublicKey;
    configId: PublicKey;
    mintAAmount: BN;
    mintBAmount: BN;
    startTime: BN;
    signer: Keypair;
  }): Promise<string> {
    try {
      const { Raydium, TxVersion } = await import(
        "@raydium-io/raydium-sdk-v2"
      );

      const raydium = await Raydium.load({ connection: this.connection });

      const mintInfoA = await this.fetchMintInfo(params.mintA);
      const mintInfoB = await this.fetchMintInfo(params.mintB);

      const { transaction } = await raydium.cpmm.createPool({
        programId: new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"),
        poolFeeAccount: new PublicKey("DNXgeM9EiQGE15fHCCMzb6rGBpB7KpGMEAGMzrsAhyKp"),
        mint1: mintInfoA,
        mint2: mintInfoB,
        ammConfig: { id: params.configId } as any,
        mintAAmount: params.mintAAmount,
        mintBAmount: params.mintBAmount,
        startTime: params.startTime,
        txVersion: TxVersion.V0,
        ownerInfo: { useSOLBalance: true },
      } as any);

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.message.recentBlockhash = blockhash;
      transaction.sign([params.signer]);

      const txSig = await this.connection.sendTransaction(transaction);
      logger.info("Raydium: CPMM pool created", { txSig });
      return txSig;
    } catch (err) {
      logger.warn("Raydium CPMM pool creation failed", { error: String(err) });
      throw err;
    }
  }

  /**
   * Get Raydium pool info via API.
   * Used for finding existing pools for LP positions.
   */
  async getPoolInfo(poolAddress: string): Promise<any | null> {
    try {
      const response = await fetch(
        `https://api-v3.raydium.io/pools/info/ids?ids=${poolAddress}`
      );
      if (!response.ok) return null;
      const data = (await response.json()) as any;
      return data.data?.[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Get top Raydium pools by TVL/volume.
   */
  async getTopPools(limit = 10): Promise<any[]> {
    try {
      const response = await fetch(
        `https://api-v3.raydium.io/pools/info/list?poolSortField=default&sortType=desc&pageSize=${limit}&page=1`
      );
      if (!response.ok) return [];
      const data = (await response.json()) as any;
      return data.data?.data || [];
    } catch {
      return [];
    }
  }
}
