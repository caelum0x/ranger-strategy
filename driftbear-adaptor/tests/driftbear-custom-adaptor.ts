import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  DriftClient,
  Wallet as DriftWallet,
  getDriftSignerPublicKey,
  getDriftStateAccountPublicKey,
  getSpotMarketPublicKey,
  getUserAccountPublicKeySync,
  getUserStatsAccountPublicKey,
} from "@drift-labs/sdk";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

const POSITION_SEED = Buffer.from("driftbear-position");
const STRATEGY_SEED = Buffer.from("driftbear-strategy");
const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
const POSITION_ACCOUNT_SIZE = 8 + 32 + 2 + 2 + 1 + 8;

function deriveStrategy(
  adaptorProgram: PublicKey,
  vault: PublicKey,
  marketIndex: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      STRATEGY_SEED,
      vault.toBuffer(),
      new BN(marketIndex).toArrayLike(Buffer, "le", 2),
    ],
    adaptorProgram
  )[0];
}

function derivePosition(adaptorProgram: PublicKey, strategy: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, strategy.toBuffer()],
    adaptorProgram
  )[0];
}

function uiToNative(amount: string, decimals: number): BN {
  const raw = amount.trim();
  if (!raw || raw === "0") {
    return new BN(0);
  }
  const [whole, fraction = ""] = raw.split(".");
  const sanitizedWhole = whole.length ? whole : "0";
  const fracPadded = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = sanitizedWhole + fracPadded;
  const normalized = combined.replace(/^0+/, "") || "0";
  return new BN(normalized);
}

async function ensureAta(
  connection: anchor.web3.Connection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (info) {
    return ata;
  }

  const ix = createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint
  );
  const tx = new Transaction().add(ix);
  await (anchor.getProvider() as anchor.AnchorProvider).sendAndConfirm(tx, []);
  return ata;
}

describe("driftbear_custom_adaptor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const adaptorProgram = anchor.workspace
    .DriftbearCustomAdaptor as Program;

  it("devnet initialize -> deposit -> withdraw", async function () {
    this.timeout(600000);

    const connection = provider.connection;
    const wallet = provider.wallet as anchor.Wallet;
    const driftEnv = (process.env.DRIFT_ENV || "devnet") as
      | "devnet"
      | "mainnet-beta";
    const marketIndex = parseInt(process.env.DRIFT_MARKET_INDEX || "0", 10);
    const subAccountId = parseInt(process.env.DRIFT_SUB_ACCOUNT_ID || "0", 10);
    const depositUi = process.env.DRIFTBEAR_DEPOSIT_AMOUNT || "1";
    const withdrawUi = process.env.DRIFTBEAR_WITHDRAW_AMOUNT || "0.5";

    const driftClient = new DriftClient({
      connection,
      wallet: new DriftWallet((wallet as any).payer ?? (wallet as any)),
      env: driftEnv,
      skipLoadUsers: true,
    });
    await driftClient.subscribe();

    const spotMarket = driftClient.getSpotMarketAccount(marketIndex);
    if (!spotMarket) {
      throw new Error(`Spot market ${marketIndex} not found on ${driftEnv}`);
    }

    const vaultPubkey = process.env.VAULT_PUBKEY
      ? new PublicKey(process.env.VAULT_PUBKEY)
      : wallet.publicKey;
    const strategy = deriveStrategy(
      adaptorProgram.programId,
      vaultPubkey,
      marketIndex
    );
    const position = derivePosition(adaptorProgram.programId, strategy);

    const driftUser = getUserAccountPublicKeySync(
      DRIFT_PROGRAM_ID,
      wallet.publicKey,
      subAccountId
    );
    const driftUserStats = getUserStatsAccountPublicKey(
      DRIFT_PROGRAM_ID,
      wallet.publicKey
    );
    const driftUserInfo = await connection.getAccountInfo(driftUser);
    if (!driftUserInfo) {
      const [sig] = await driftClient.initializeUserAccount(subAccountId);
      await connection.confirmTransaction(sig, "confirmed");
    }

    const strategyTokenAta = await ensureAta(
      connection,
      wallet.publicKey,
      spotMarket.mint,
      wallet.publicKey
    );
    const driftState = await getDriftStateAccountPublicKey(DRIFT_PROGRAM_ID);
    const spotMarketPubkey = await getSpotMarketPublicKey(
      DRIFT_PROGRAM_ID,
      marketIndex
    );
    const driftSigner = getDriftSignerPublicKey(DRIFT_PROGRAM_ID);

    const depositAmount = uiToNative(depositUi, spotMarket.decimals);
    const withdrawAmount = uiToNative(withdrawUi, spotMarket.decimals);

    if (depositAmount.gt(new BN(0))) {
      const ata = await getAccount(connection, strategyTokenAta);
      const balance = new BN(ata.amount.toString());
      if (balance.lt(depositAmount)) {
        throw new Error(
          `Insufficient balance in strategy ATA (${balance.toString()}) for deposit ${depositAmount.toString()}.`
        );
      }
    }

    const positionInfo = await connection.getAccountInfo(position);
    if (positionInfo) {
      const sig = await adaptorProgram.methods
        .migratePosition()
        .accounts({
          payer: wallet.publicKey,
          authority: wallet.publicKey,
          strategy,
          position,
          driftUser,
          driftUserStats,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      console.log(
        positionInfo.data.length < POSITION_ACCOUNT_SIZE
          ? "Migrate tx (realloc):"
          : "Migrate tx (sync):",
        sig
      );
    } else {
      const sig = await adaptorProgram.methods
        .initialize(marketIndex)
        .accounts({
          payer: wallet.publicKey,
          authority: wallet.publicKey,
          strategy,
          position,
          driftState,
          driftUser,
          driftUserStats,
          driftProgram: DRIFT_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      console.log("Init tx:", sig);
    }

    if (depositAmount.gt(new BN(0))) {
      const sig = await adaptorProgram.methods
        .deposit(depositAmount)
        .accounts({
          strategyAuthority: wallet.publicKey,
          strategy,
          vaultAssetMint: spotMarket.mint,
          strategyTokenAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          position,
          driftState,
          driftUser,
          driftUserStats,
          spotMarket: spotMarketPubkey,
          spotMarketVault: spotMarket.vault,
          spotMarketOracle: spotMarket.oracle,
          driftProgram: DRIFT_PROGRAM_ID,
        })
        .rpc();
      console.log("Deposit tx:", sig);
    }

    if (withdrawAmount.gt(new BN(0))) {
      const sig = await adaptorProgram.methods
        .withdraw(withdrawAmount)
        .accounts({
          strategyAuthority: wallet.publicKey,
          strategy,
          vaultAssetMint: spotMarket.mint,
          strategyTokenAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          position,
          driftState,
          driftUser,
          driftUserStats,
          spotMarket: spotMarketPubkey,
          spotMarketVault: spotMarket.vault,
          spotMarketOracle: spotMarket.oracle,
          driftSigner,
          driftProgram: DRIFT_PROGRAM_ID,
        })
        .rpc();
      console.log("Withdraw tx:", sig);
    }

    await driftClient.unsubscribe();
  });
});
