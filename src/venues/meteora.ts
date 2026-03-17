/**
 * Meteora DLMM integration — real SDK for dynamic LP.
 *
 * Ported from meteora-plugin/tools/create_meteora_dlmm_pool.ts.
 * Uses @meteora-ag/dlmm for actual DLMM pool management.
 */
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { logger } from "../utils/logger";

export interface MeteoraDLMMPool {
  address: string;
  mintA: string;
  mintB: string;
  binStep: number;
  baseFeeRateBps: number;
  activeId: number;
  currentPrice: number;
  tvl: number;
  apr24h: number;
}

export class MeteoraClient {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Get top DLMM pools by APR.
   * Real API call used by engine.scanLPYields() every cycle.
   */
  async getTopPools(limit = 10): Promise<MeteoraDLMMPool[]> {
    try {
      const response = await fetch(
        `https://dlmm-api.meteora.ag/pair/all_with_pagination?limit=${limit}&sort_key=fee_apr&order_by=desc`
      );
      if (!response.ok) return [];
      const data = (await response.json()) as any;
      return (data.data || data.pairs || []).map((p: any) => ({
        address: p.address || "",
        mintA: p.mint_x || "",
        mintB: p.mint_y || "",
        binStep: p.bin_step || 0,
        baseFeeRateBps: p.base_fee_percentage ? parseFloat(p.base_fee_percentage) * 100 : 0,
        activeId: p.active_id || 0,
        currentPrice: p.current_price || 0,
        tvl: p.liquidity ? parseFloat(p.liquidity) : 0,
        apr24h: p.apr || p.fee_apr || 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Create a DLMM pool instance from on-chain data.
   * From: meteora-plugin — DLMM.create()
   */
  async getPool(poolAddress: PublicKey): Promise<DLMM | null> {
    try {
      const dlmmPool = await DLMM.create(this.connection, poolAddress);
      logger.info("Meteora: loaded DLMM pool", {
        address: poolAddress.toBase58().slice(0, 8),
        binStep: dlmmPool.lbPair.binStep,
        activeId: dlmmPool.lbPair.activeId,
      });
      return dlmmPool;
    } catch (err) {
      logger.debug("Meteora pool load failed", { error: String(err) });
      return null;
    }
  }

  /**
   * Get active bin price for a pool.
   * From: @meteora-ag/dlmm — pool.getActiveBin()
   */
  async getActiveBinPrice(poolAddress: PublicKey): Promise<number | null> {
    try {
      const pool = await this.getPool(poolAddress);
      if (!pool) return null;
      const activeBin = await pool.getActiveBin();
      return parseFloat(activeBin.price);
    } catch {
      return null;
    }
  }
}
