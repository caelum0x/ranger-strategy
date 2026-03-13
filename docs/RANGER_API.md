# Ranger Earn (Voltr) API — Technical Reference for AI Agents

## Overview

Ranger Earn (formerly Voltr) is a permissionless, modular vault infrastructure on Solana. Vault managers create vaults that accept user deposits (USDC, SOL, etc.), allocate capital to yield strategies via **adaptors**, and distribute returns via LP token share price appreciation.

## Program Addresses (Mainnet)

| Program | Address |
|---------|---------|
| Vault Program | `vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8` |
| Lending Adaptor | `aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz` |
| Drift Adaptor | `EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP` |
| Raydium Adaptor | `A5a3Xo2JaKbXNShSHHP4Fe1LxcxNuCZs97gy3FJMSzkM` |
| Kamino Adaptor | `to6Eti9CsC5FGkAtqiPphvKD2hiQiLsS8zWiDBqBPKR` |
| Jupiter Adaptor | `EW35URAx3LiM13fFK3QxAXfGemHso9HWPixrv7YDY4AM` |

## REST API

**Base URL:** `https://api.voltr.xyz`
**Auth:** None required (public API)
**Docs:** `https://api.voltr.xyz/docs` (Swagger)

### Vault Information

```
GET /vault/{pubkey}                              → Vault details (config, APY, TVL, allocations)
GET /vault/{pubkey}/share-price?ts={timestamp}   → Historical share price
GET /vault/{pubkey}/fee-earned?startTs=&endTs=    → Accumulated fees in range
GET /vault/{pubkey}/user/{userPubkey}/balance     → User's vault balance in underlying asset
GET /vault/{pubkey}/user/{userPubkey}/pending-withdrawal → Withdrawal request status
GET /vaults                                      → List all active vaults
GET /vaults/tvl                                  → Total TVL across all vaults
```

### Transaction Building

All POST endpoints return **unsigned serialized transactions** (base58). Deserialize, sign with wallet, and broadcast.

```
POST /vault/{pubkey}/deposit
  Body: { userPubkey, lamportAmount, assetMint?, assetTokenProgram? }

POST /vault/{pubkey}/request-withdrawal
  Body: { userPubkey, lamportAmount, isAmountInLp?, isWithdrawAll? }

POST /vault/{pubkey}/withdraw
  Body: { userPubkey, assetMint?, assetTokenProgram? }

POST /vault/{pubkey}/direct-withdraw
  Body: { userPubkey, lamportAmount, isWithdrawAll, assetMint?, assetTokenProgram? }

POST /vault/{pubkey}/cancel-withdrawal
  Body: { userPubkey }
```

## TypeScript SDK

```bash
npm install @voltr/vault-sdk
```

### Initialize Client

```typescript
import { VoltrClient } from "@voltr/vault-sdk";
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const client = new VoltrClient(connection, wallet);
```

### Constants

```typescript
VAULT_PROGRAM_ID = "vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8"
LENDING_ADAPTOR_PROGRAM_ID = "aVoLTRCRt3NnnchvLYH6rMYehJHwM5m45RmLBZq7PGz"
DRIFT_ADAPTOR_PROGRAM_ID = "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP"
```

### Vault Configuration

```typescript
interface VaultConfig {
  maxCap: BN;                              // Maximum vault capacity
  startAtTs: BN;                           // Vault launch timestamp
  lockedProfitDegradationDuration: BN;     // Profit lock duration
  managerManagementFee: number;            // Basis points (1000 = 10%)
  managerPerformanceFee: number;           // Basis points
  adminManagementFee: number;              // Basis points
  adminPerformanceFee: number;             // Basis points
  redemptionFee: number;                   // Withdrawal fee (BPS)
  issuanceFee: number;                     // Deposit fee (BPS)
  withdrawalWaitingPeriod: BN;             // Time before withdrawal claimable
}
```

### Core Operations

```typescript
// Create vault
const ix = await client.createInitializeVaultIx(
  { config, name: "My Vault", description: "..." },
  { admin, manager, assetMint, vault }
);

// User deposit
const ix = await client.createDepositVaultIx(amount, {
  userTransferAuthority, vault, userAssetAta, userLpAta
});

// Allocate to strategy (manager)
const ix = await client.createDepositStrategyIx(
  { amount },
  { vault, strategy, manager }
);

// Withdraw from strategy (manager)
const ix = await client.createWithdrawStrategyIx(
  { amount },
  { vault, strategy, manager }
);

// Query vault state
const vaultAccount = await client.fetchVaultAccount(vaultKey);
const sharePrice = await client.getCurrentAssetPerLpForVault(vaultAccount);
const { totalValue, strategies } = await client.getPositionAndTotalValuesForVault(vaultAccount);
```

### PDA Derivation

```typescript
client.findVaultLpMint(vault)
client.findVaultAssetIdleAuth(vault)
client.findVaultAddresses(vault)
client.findVaultStrategyAuth(vault, strategy)
client.findStrategyInitReceipt(vault, strategy)
client.findRequestWithdrawVaultReceipt(vault, user)
```

## Adaptor Architecture

Adaptors are Solana programs implementing 3 instructions:

1. **initialize** — Set up protocol-specific accounts when strategy is created
2. **deposit** — Deploy vault idle tokens into external protocol, return position value (u64)
3. **withdraw** — Pull tokens from protocol back to vault, return remaining position value (u64)

## Vault Manager Operational Flow

```
1. Create vault (set fees, caps, waiting periods)
2. Add adaptors (register which protocols the vault can use)
3. Initialize strategies (link vault to adaptor + specific market)
4. Deposit to strategies (allocate idle capital to yield protocols)
5. Rebalance (periodically redistribute capital for optimal yield)
6. Harvest fees (collect management + performance fees)
```

## Vault Operations (Post-Launch)

Once a vault is live with initialized strategies and allocated funds, the vault manager is responsible for ongoing operations.

### Operational Responsibilities

| Responsibility | Frequency | Automation |
|----------------|-----------|------------|
| Monitor vault health | Continuous | Required |
| Rebalance allocations | Hourly/daily | Required |
| Respond to market conditions | As needed | Strategy-dependent |
| Maintain SOL balance for tx fees | Weekly | Optional |
| Monitor strategy performance | Daily | Required |

### Role-Based Access Control

| Role | Capabilities |
|------|-------------|
| Admin | Add/remove adaptors, initialize strategies, update vault config, calibrate high water mark |
| Manager | Allocate funds between strategies (deposit/withdraw to strategies) |

Keep admin and manager as **separate keypairs**. Admin controls vault structure; manager controls fund movement.

### Vault Account Structure

```typescript
interface Vault {
  name: string;           // Max 32 bytes
  description: string;    // Max 64 bytes
  asset: {
    mint: PublicKey;      // Token mint address
    idleAuth: PublicKey;  // Idle token authority
    totalValue: BN;       // Total assets in vault
  };
  vaultConfiguration: {
    maxCap: BN;
    startAtTs: BN;
    lockedProfitDegradationDuration: BN;
    withdrawalWaitingPeriod: BN;
  };
  feeConfiguration: {
    managerPerformanceFee: number;   // In basis points
    adminPerformanceFee: number;
    managerManagementFee: number;
    adminManagementFee: number;
    redemptionFee: number;
    issuanceFee: number;
  };
  admin: PublicKey;
  manager: PublicKey;
}
```

### Vault Creation (Full Example)

```typescript
import { BN } from "@coral-xyz/anchor";
import { VaultConfig, VaultParams, VoltrClient } from "@voltr/vault-sdk";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";

const vaultConfig: VaultConfig = {
  maxCap: new BN("18446744073709551615"),         // Uncapped (u64 max)
  startAtTs: new BN(0),                           // Immediate activation
  lockedProfitDegradationDuration: new BN(86400), // 24 hours
  managerPerformanceFee: 2000,                    // 20%
  adminPerformanceFee: 0,
  managerManagementFee: 100,                      // 1%
  adminManagementFee: 0,
  redemptionFee: 0,
  issuanceFee: 0,
  withdrawalWaitingPeriod: new BN(3600),          // 1 hour
};

// CRITICAL: maxCap of 0 means ZERO capacity, not unlimited!
// For uncapped vault use: new BN("18446744073709551615")

// Description limit: 64 characters max or transaction will fail
```

### Strategy Setup

```typescript
// 1. Add adaptor (one-time per adaptor type)
const addAdaptorIx = await client.createAddAdaptorIx({
  vault, admin, payer, adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
});

// 2. Initialize strategy (protocol-specific)
const initStrategyIx = await client.createInitializeStrategyIx(
  { instructionDiscriminator: Buffer.from([/* 8-byte discriminator */]) },
  { payer, manager, vault, strategy, adaptorProgram, remainingAccounts: [...] }
);
```

### Available Strategy Types

| Strategy Type | Adaptor | Protocols |
|--------------|---------|-----------|
| Lending | Lending Adaptor | Kamino, Marginfi, Save, Drift Spot, Jupiter Lend |
| Drift Perps/JLP | Drift Adaptor | Drift Protocol |
| Raydium CLMM | Raydium Adaptor | Raydium |
| Off-chain (CEX) | Trustful Adaptor | CEX, OTC, MPC |

### LP Token Metadata

```typescript
const metadataIx = await client.createCreateLpMetadataIx(
  { name: "My Vault LP", symbol: "mvLP", uri: "https://your-domain.com/metadata.json" },
  { vault, admin, payer }
);
```

Metadata JSON format (host publicly):
```json
{
  "name": "My Vault LP",
  "symbol": "mvLP",
  "description": "LP token for My Vault on Ranger Earn",
  "image": "https://your-domain.com/vault-logo.png"
}
```

## Key Repositories

| Repo | URL | Purpose |
|------|-----|---------|
| vault-sdk | github.com/voltrxyz/vault-sdk | TypeScript SDK |
| vault-cpi | github.com/voltrxyz/vault-cpi | Rust CPI integration |
| client-scripts | github.com/voltrxyz/client-scripts | Admin/manager/user scripts |
| rebalance-bot-template | github.com/voltrxyz/rebalance-bot-template | Automated rebalancing bot |
| ranger-agent-kit | github.com/ranger-finance/ranger-agent-kit | MCP-based AI agent toolkit |
| drift-scripts | github.com/voltrxyz/drift-scripts | Drift-specific vault scripts |

## SOR (Smart Order Router) API — Perps Trading

Ranger also operates a perps aggregator with a separate API (requires API key).

```
GET  /v1/positions                                    → All open positions
GET  /v1/symbols                                      → Available trading pairs
GET  /v1/quotes?symbol=SOL-PERP&side=Long&size=1.0   → Price quotes
POST /v1/increase                                     → Open/increase positions
POST /v1/close                                        → Close positions
```

SDK: `ranger-sor-sdk` (import `SorApi`, `TradeSide`).
