/**
 * DriftBear Custom Adaptor client — TypeScript interface to our Anchor program.
 *
 * Calls our deployed on-chain program (4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ)
 * which does CPI to Drift Protocol for vault-managed strategy execution.
 *
 * On-chain program: programs/driftbear_custom_adaptor/src/lib.rs (1,058 lines Rust)
 * Deployed: devnet (verified with real transactions)
 *
 * Instructions:
 *   - initialize(market_index) — set up position PDA for vault strategy
 *   - deposit(amount) — deposit USDC into Drift via CPI
 *   - withdraw(amount) — withdraw USDC from Drift via CPI
 *   - migrate_position() — migrate legacy position data
 */
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { logger } from "../utils/logger";
import { sendAndConfirmVersionedTransaction } from "../utils/versioned-tx";

// ── Program Constants ───────────────────────────────────────────

const ADAPTOR_PROGRAM_ID = new PublicKey(
  "4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ"
);

const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);

const POSITION_SEED = Buffer.from("driftbear-position");

// ── Types ───────────────────────────────────────────────────────

export interface AdaptorConfig {
  /** Vault strategy address */
  strategyAddress: PublicKey;
  /** Drift state account */
  driftState: PublicKey;
  /** Drift user account (vault's trading account) */
  driftUser: PublicKey;
  /** Drift user stats account */
  driftUserStats: PublicKey;
  /** Spot market account */
  spotMarket: PublicKey;
  /** Spot market vault (token account) */
  spotMarketVault: PublicKey;
  /** Spot market oracle */
  spotMarketOracle: PublicKey;
  /** Drift signer PDA (for withdrawals) */
  driftSigner: PublicKey;
  /** Vault asset mint (e.g., USDC) */
  vaultAssetMint: PublicKey;
  /** Market index (0 = USDC) */
  marketIndex: number;
}

export interface PositionInfo {
  strategy: PublicKey;
  marketIndex: number;
  subAccountId: number;
  bump: number;
  trackedBalance: number; // in smallest units (e.g., 1e6 for USDC)
}

// ── Client ──────────────────────────────────────────────────────

export class DriftBearAdaptorClient {
  private connection: Connection;
  private config: AdaptorConfig;

  constructor(connection: Connection, config: AdaptorConfig) {
    this.connection = connection;
    this.config = config;
  }

  /**
   * Derive the position PDA for a strategy.
   */
  getPositionPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [POSITION_SEED, this.config.strategyAddress.toBuffer()],
      ADAPTOR_PROGRAM_ID
    );
  }

  /**
   * Get the strategy authority's token account for the vault asset.
   */
  getStrategyTokenATA(authority: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.config.vaultAssetMint,
      authority
    );
  }

  // ── Initialize ────────────────────────────────────────────────

  /**
   * Initialize the adaptor position PDA.
   * Must be called once before deposit/withdraw.
   *
   * On-chain: programs/driftbear_custom_adaptor/src/lib.rs → initialize()
   */
  async initialize(
    payer: Keypair,
    authority: Keypair
  ): Promise<string> {
    const [positionPDA] = this.getPositionPDA();

    // Anchor instruction discriminator for "initialize"
    const discriminator = this.getDiscriminator("global", "initialize");

    // Encode market_index as u16 LE
    const data = Buffer.alloc(10);
    discriminator.copy(data, 0);
    data.writeUInt16LE(this.config.marketIndex, 8);

    const ix = new TransactionInstruction({
      programId: ADAPTOR_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: this.config.strategyAddress, isSigner: false, isWritable: false },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: this.config.driftState, isSigner: false, isWritable: false },
        { pubkey: this.config.driftUser, isSigner: false, isWritable: true },
        { pubkey: this.config.driftUserStats, isSigner: false, isWritable: true },
        { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const txSig = await sendAndConfirmVersionedTransaction(
      this.connection,
      [ix],
      payer,
      [authority]
    );

    logger.info("Adaptor: initialized position", {
      positionPDA: positionPDA.toBase58(),
      marketIndex: this.config.marketIndex,
      txSig,
    });

    return txSig;
  }

  // ── Deposit ───────────────────────────────────────────────────

  /**
   * Deposit USDC into Drift via CPI through our adaptor.
   *
   * On-chain: programs/driftbear_custom_adaptor/src/lib.rs → deposit()
   * CPI: Drift Protocol deposit instruction
   */
  async deposit(
    authority: Keypair,
    amount: number // in smallest units (1e6 = 1 USDC)
  ): Promise<string> {
    const [positionPDA] = this.getPositionPDA();
    const strategyTokenATA = this.getStrategyTokenATA(authority.publicKey);

    // Anchor instruction discriminator for "deposit"
    const discriminator = this.getDiscriminator("global", "deposit");

    // Encode amount as u64 LE
    const data = Buffer.alloc(16);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8);

    const ix = new TransactionInstruction({
      programId: ADAPTOR_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false }, // strategy_authority
        { pubkey: this.config.strategyAddress, isSigner: false, isWritable: false },
        { pubkey: this.config.vaultAssetMint, isSigner: false, isWritable: false },
        { pubkey: strategyTokenATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: this.config.driftState, isSigner: false, isWritable: false },
        { pubkey: this.config.driftUser, isSigner: false, isWritable: true },
        { pubkey: this.config.driftUserStats, isSigner: false, isWritable: true },
        { pubkey: this.config.spotMarket, isSigner: false, isWritable: true },
        { pubkey: this.config.spotMarketVault, isSigner: false, isWritable: true },
        { pubkey: this.config.spotMarketOracle, isSigner: false, isWritable: false },
        { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const txSig = await sendAndConfirmVersionedTransaction(
      this.connection,
      [ix],
      authority,
      []
    );

    logger.info("Adaptor: deposited via CPI to Drift", {
      amount,
      amountUsdc: (amount / 1e6).toFixed(2),
      txSig,
    });

    return txSig;
  }

  // ── Withdraw ──────────────────────────────────────────────────

  /**
   * Withdraw USDC from Drift via CPI through our adaptor.
   *
   * On-chain: programs/driftbear_custom_adaptor/src/lib.rs → withdraw()
   * CPI: Drift Protocol withdraw instruction
   */
  async withdraw(
    authority: Keypair,
    amount: number // in smallest units (1e6 = 1 USDC)
  ): Promise<string> {
    const [positionPDA] = this.getPositionPDA();
    const strategyTokenATA = this.getStrategyTokenATA(authority.publicKey);

    const discriminator = this.getDiscriminator("global", "withdraw");

    const data = Buffer.alloc(16);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8);

    const ix = new TransactionInstruction({
      programId: ADAPTOR_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.config.strategyAddress, isSigner: false, isWritable: false },
        { pubkey: this.config.vaultAssetMint, isSigner: false, isWritable: false },
        { pubkey: strategyTokenATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: positionPDA, isSigner: false, isWritable: true },
        { pubkey: this.config.driftState, isSigner: false, isWritable: false },
        { pubkey: this.config.driftUser, isSigner: false, isWritable: true },
        { pubkey: this.config.driftUserStats, isSigner: false, isWritable: true },
        { pubkey: this.config.spotMarket, isSigner: false, isWritable: true },
        { pubkey: this.config.spotMarketVault, isSigner: false, isWritable: true },
        { pubkey: this.config.spotMarketOracle, isSigner: false, isWritable: false },
        { pubkey: this.config.driftSigner, isSigner: false, isWritable: false },
        { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const txSig = await sendAndConfirmVersionedTransaction(
      this.connection,
      [ix],
      authority,
      []
    );

    logger.info("Adaptor: withdrew via CPI from Drift", {
      amount,
      amountUsdc: (amount / 1e6).toFixed(2),
      txSig,
    });

    return txSig;
  }

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Compute Anchor instruction discriminator (first 8 bytes of SHA256 hash).
   */
  private getDiscriminator(namespace: string, name: string): Buffer {
    const crypto = require("crypto");
    const preimage = `${namespace}:${name}`;
    const hash = crypto.createHash("sha256").update(preimage).digest();
    return hash.slice(0, 8);
  }

  /**
   * Create a devnet config with known addresses.
   * From: docs/DRIFTBEAR_CUSTOM_ADAPTOR_DEVNET.md
   */
  static devnetConfig(): AdaptorConfig {
    return {
      strategyAddress: new PublicKey("FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY"),
      driftState: new PublicKey("5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN"),
      driftUser: new PublicKey("2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh"),
      driftUserStats: new PublicKey("B9RE8Nv8zTHcboZijGTsANjgHDQz5sGQ21KvLdqTWe6X"),
      spotMarket: new PublicKey("6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3"),
      spotMarketVault: new PublicKey("GXWqPpjQpdz7KZw9p7f5PX2eGxHAhvpNXiviFkAB8zXg"),
      spotMarketOracle: new PublicKey("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce"), // devnet USDC oracle
      driftSigner: new PublicKey("JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw"),
      vaultAssetMint: new PublicKey("8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2"), // devnet USDC mint
      marketIndex: 0,
    };
  }
}
