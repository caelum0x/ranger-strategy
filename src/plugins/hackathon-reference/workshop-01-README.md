# Build-a-Bear Workshop: Building Yield Vaults on Ranger Earn

Welcome to the Build-a-Bear Workshop! In this hands-on session, you'll learn how to create and manage yield-generating vaults on Solana using the **Ranger Earn (Voltr)** protocol.

By the end of this workshop, you will have:

- Initialized a vault
- Deposited funds into the vault
- Connected 3 DeFi protocols (Jupiter Lend, Drift, Kamino) as yield strategies
- Set up an automated rebalance bot

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Architecture Overview](#architecture-overview)
- [Step 0: Environment Setup](#step-0-environment-setup)
- [Step 1: Initialize Vault](#step-1-initialize-vault-admin)
- [Step 2: Add Jupiter (Spot) Adaptor](#step-2-add-jupiter-spot-adaptor-admin)
- [Step 3: Initialize Jupiter Earn Strategy](#step-3-initialize-jupiter-earn-strategy-manager)
- [Step 4: Add Drift Adaptor](#step-4-add-drift-adaptor-admin)
- [Step 5: Initialize Drift Earn Strategy](#step-5-initialize-drift-earn-strategy-manager)
- [Step 6: Add Kamino Adaptor](#step-6-add-kamino-adaptor-admin)
- [Step 7: Initialize Kamino Market Strategy](#step-7-initialize-kamino-market-strategy-manager)
- [Step 8: Deposit into Vault](#step-8-deposit-into-vault-user)
- [Step 9: Run the Rebalance Bot](#step-9-run-the-rebalance-bot)
- [Resources](#resources)

---

## Prerequisites

1. **Node.js v18+** installed
2. **pnpm** installed (`npm install -g pnpm`)
3. **Solana CLI** installed ([install guide](https://docs.solanalabs.com/cli/install))
4. **3 Solana Keypair files** (JSON format):
   - **Admin** — manages vault configuration, adds adaptors
   - **Manager** — initializes strategies, allocates funds
   - **User** — deposits/withdraws from the vault

   Generate each keypair using the Solana CLI:

   ```bash
   solana-keygen new --outfile ~/admin.json
   solana-keygen new --outfile ~/manager.json
   solana-keygen new --outfile ~/user.json
   ```

   To view the public key of a keypair:

   ```bash
   solana-keygen pubkey ~/admin.json
   ```
5. **Solana RPC URL** (e.g. from [Helius](https://helius.dev), [Triton](https://triton.one), or [QuickNode](https://quicknode.com))
6. **SOL in all 3 wallets** for transaction fees
7. **Token balance** (e.g. USDC) in the User wallet for depositing

---

## Architecture Overview

```
                    ┌─────────────────────────────┐
                    │         Voltr Vault          │
                    │   (Deposits, LP Tokens,      │
                    │    Accounting, Fees)          │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
     │ Jupiter/Spot  │ │    Drift     │ │    Kamino    │
     │   Adaptor     │ │   Adaptor    │ │   Adaptor    │
     └────────┬──────┘ └──────┬───────┘ └──────┬───────┘
              │                │                │
     ┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
     │ Jupiter Lend  │ │ Drift Spot   │ │ Kamino Lend  │
     │   Protocol    │ │  (Mkt 0)     │ │   Markets    │
     └───────────────┘ └──────────────┘ └──────────────┘
```

**Roles:**

| Role | Responsibilities |
|------|-----------------|
| **Admin** | Create vault, add adaptors, update config, harvest fees |
| **Manager** | Initialize strategies, allocate funds, rebalance |
| **User** | Deposit/withdraw assets, receive LP tokens |

---

## Step 0: Environment Setup

### 0.1 Clone the required repositories

```bash
# Base scripts (vault init + deposit)
git clone https://github.com/voltrxyz/base-scripts.git
cd base-scripts && pnpm install && cd ..

# Spot/Jupiter scripts (adaptor + earn strategy)
git clone https://github.com/voltrxyz/spot-scripts.git
cd spot-scripts && pnpm install && cd ..

# Drift scripts (adaptor + earn strategy)
git clone https://github.com/voltrxyz/drift-scripts.git
cd drift-scripts && pnpm install && cd ..

# Kamino scripts (adaptor + market strategy)
git clone https://github.com/voltrxyz/kamino-scripts.git
cd kamino-scripts && pnpm install && cd ..

# Rebalance bot
git clone https://github.com/voltrxyz/rebalance-bot-template.git
cd rebalance-bot-template && pnpm install && cd ..
```

### 0.2 Configure environment variables

Create a `.env` file in **each** script repo (`base-scripts`, `spot-scripts`, `drift-scripts`, `kamino-scripts`) with:

```bash
ADMIN_FILE_PATH="/path/to/your/admin.json"
MANAGER_FILE_PATH="/path/to/your/manager.json"
USER_FILE_PATH="/path/to/your/user.json"
HELIUS_RPC_URL="https://your-rpc-url"
```

> **Security:** Never commit your keypair files to git.

### 0.3 Configure `config/base.ts` (in each script repo)

This file drives all vault operations. You need to fill in the following fields:

```typescript
// --- VAULT INITIALIZATION PARAMS (Step 1 only) ---
export const vaultParams: VaultParams = {
  config: vaultConfig,
  name: "",          // <-- your vault name (max 32 chars)
  description: "",   // <-- your vault description (max 64 chars)
};

// --- ASSET CONFIGURATION ---
export const assetMintAddress = "";       // <-- token mint (e.g. USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
export const assetTokenProgram = "";      // <-- TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA for standard SPL tokens

// --- FILL AFTER STEP 1 (admin-init-vault) ---
export const vaultAddress = "";           // <-- paste vault address here after Step 1
export const lookupTableAddress = "";     // <-- paste LUT address here after Step 1

// --- DEPOSIT AMOUNT (Step 2 only) ---
export const depositAmountVault = 1_000_000;  // 1 USDC (6 decimals)
```

The remaining fields in `config/base.ts` (`vaultConfig` fees, `useLookupTable`, `withdrawAmountVault`, etc.) have sensible defaults and don't need to be changed for this workshop.

---

## Step 1: Initialize Vault (Admin)

**Repo:** `base-scripts`
**Script:** `src/scripts/admin-init-vault.ts`
**Role:** Admin (pays for creation), Manager (designated during init)

This creates a new on-chain vault and an Address Lookup Table (LUT).

```bash
cd base-scripts
pnpm ts-node src/scripts/admin-init-vault.ts
```

**What happens:**
1. Generates a new vault keypair
2. Calls `createInitializeVaultIx` with your vault params
3. Creates and extends an Address Lookup Table

**Output — save these values:**
```
Vault initialized with signature: <tx_sig>
Update below vault address into config/base.ts
Vault: <VAULT_ADDRESS>         # <-- copy this
LUT: <LOOKUP_TABLE_ADDRESS>    # <-- copy this
```

**Action Required:** Update `vaultAddress` and `lookupTableAddress` in `config/base.ts` across **ALL** script repos.

---

## Step 2: Add Jupiter (Spot) Adaptor (Admin)

**Repo:** `spot-scripts`
**Script:** `src/scripts/admin-add-adaptor.ts`
**Role:** Admin

Registers the Jupiter/Spot Adaptor program with your vault so it can interact with Jupiter Lend.

```bash
cd spot-scripts
pnpm ts-node src/scripts/admin-add-adaptor.ts
```

**What happens:**
1. Calls `createAddAdaptorIx` to register the Jupiter adaptor with your vault
2. Extends the LUT with new accounts (if enabled)

---

## Step 3: Initialize Jupiter Earn Strategy (Manager)

**Repo:** `spot-scripts`
**Script:** `src/scripts/manager-initialize-earn.ts`
**Role:** Manager

Sets up the Jupiter Lend strategy — derives PDAs for fToken mint, lending account, and initializes the strategy on-chain.

```bash
cd spot-scripts
pnpm ts-node src/scripts/manager-initialize-earn.ts
```

**What happens:**
1. Derives Jupiter Lend PDAs (`fTokenMint`, `lending` account) from the asset mint
2. Creates token accounts for the vault's strategy authority
3. Calls `createInitializeStrategyIx` with Jupiter Earn discriminator
4. Extends the LUT with all Jupiter-related accounts

No additional configuration needed beyond `config/base.ts`.

---

## Step 4: Add Drift Adaptor (Admin)

**Repo:** `drift-scripts`
**Script:** `src/scripts/admin-add-adaptor.ts`
**Role:** Admin

Registers the Drift Adaptor program with your vault.

```bash
cd drift-scripts
pnpm ts-node src/scripts/admin-add-adaptor.ts
```

**What happens:**
1. Calls `createAddAdaptorIx` to register the Drift adaptor with your vault
2. Extends the LUT (if enabled)

---

## Step 5: Initialize Drift Earn Strategy (Manager)

**Repo:** `drift-scripts`
**Script:** `src/scripts/manager-init-earn.ts`
**Role:** Manager

Initializes the Drift spot lending strategy (Market Index 0 = USDC). Creates Drift user accounts and strategy state.

```bash
cd drift-scripts
pnpm ts-node src/scripts/manager-init-earn.ts
```

**Configuration:** Set the market index in `config/drift.ts`:

```typescript
import { DRIFT } from "../src/constants/drift";

export const driftMarketIndex = DRIFT.SPOT.USDC.MARKET_INDEX; // Market Index 0 = USDC
```

> **Important:** The `driftMarketIndex` must correspond to the same asset as your vault's `assetMintAddress`. No automatic swaps are performed.

**What happens:**
1. Derives Drift PDAs (`spotMarketVault`, `spotMarket`, `userStats`, `user`)
2. Creates token accounts for the strategy authority
3. Calls `createInitializeStrategyIx` with remaining accounts for Drift
4. Extends the LUT

---

## Step 6: Add Kamino Adaptor (Admin)

**Repo:** `kamino-scripts`
**Script:** `src/scripts/admin-add-adaptor.ts`
**Role:** Admin

Registers the Kamino Adaptor program with your vault.

```bash
cd kamino-scripts
pnpm ts-node src/scripts/admin-add-adaptor.ts
```

**What happens:**
1. Calls `createAddAdaptorIx` to register the Kamino adaptor with your vault
2. Extends the LUT (if enabled)

---

## Step 7: Initialize Kamino Market Strategy (Manager)

**Repo:** `kamino-scripts`
**Script:** `src/scripts/manager-initialize-market.ts`
**Role:** Manager

Initializes a Kamino lending market strategy using the Kamino Main Market USDC reserve.

**Configuration:** Set the reserve address in `config/kamino.ts`:

```typescript
export const reserveAddress = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"; // Kamino Main Market USDC Reserve
```

```bash
cd kamino-scripts
pnpm ts-node src/scripts/manager-initialize-market.ts
```

**What happens:**
1. Fetches the Kamino reserve on-chain to derive `lendingMarket`, `obligation`, and farm accounts
2. Creates token accounts for the strategy authority
3. Calls `createInitializeStrategyIx` with Kamino-specific remaining accounts (obligation, farm state, user metadata, etc.)
4. Extends the LUT

---

## Step 8: Deposit into Vault (User)

**Repo:** `base-scripts`
**Script:** `src/scripts/user-deposit-vault.ts`
**Role:** User

Deposits tokens from the User wallet into the vault, receiving LP tokens in return. This step is done after all strategies are initialized so that the rebalance bot can immediately begin allocating funds across strategies.

```bash
cd base-scripts
pnpm ts-node src/scripts/user-deposit-vault.ts
```

**What happens:**
1. If the asset is SOL, wraps to wSOL automatically
2. Creates the user's LP token account if needed
3. Calls `createDepositVaultIx` with the configured `depositAmountVault`
4. If the asset was SOL, unwraps remaining wSOL

**Configuration:** Set `depositAmountVault` in `config/base.ts` (in smallest units, e.g. `1_000_000` = 1 USDC).

---

## Step 9: Run the Rebalance Bot

**Repo:** `rebalance-bot-template`

The rebalance bot automatically distributes funds equally across all strategies on a schedule.

### 9.1 Configure `.env`

```bash
cd rebalance-bot-template
cp .env.example .env
```

Fill in `.env`:

```bash
# Core
RPC_URL=https://your-rpc-url
MANAGER_SECRET_PATH=/path/to/your/manager.json

# On-Chain Addresses (from previous steps)
VOLTR_VAULT_ADDRESS=           # <-- your vault address from Step 1
VOLTR_VAULT_ADMIN_ADDRESS=     # <-- your admin public key
VOLTR_VAULT_MANAGER_ADDRESS=   # <-- your manager public key
ASSET_MINT_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
ASSET_TOKEN_PROGRAM=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
VOLTR_LOOKUP_TABLE_ADDRESS=    # <-- your LUT address from Step 1
```

### 9.2 Configure `strategies.json`

Edit `strategies.json` to match the 3 strategies initialized in Steps 4, 6, and 8:

```json
{
  "strategies": [
    { "id": "jupiterLend", "type": "jupiterLend" },
    { "id": "driftMain", "type": "driftEarn", "marketIndex": 0 },
    { "id": "kaminoMainMarket", "type": "kaminoMarket", "address": "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59" }
  ]
}
```

### 9.3 Run the bot

```bash
# Build and run
pnpm run build
pnpm start

# Or dev mode
pnpm run dev
```

**Bot loops:**

| Loop | Default Interval | Purpose |
|------|-----------------|---------|
| Rebalance | 30 min | Equal-weight allocation across strategies |
| Refresh | 10 min | Refreshes on-chain position values |
| Harvest Fee | 30 min | Collects accumulated vault fees |
| Claim Rewards | 1 hr | Claims Kamino farm rewards + swaps via Jupiter |

The bot exposes a health check at `http://localhost:9090/health`.

---

## Workshop Checklist

Use this to track your progress:

- [ ] **Setup:** Clone repos, install deps, configure `.env` and `config/base.ts`
- [ ] **Step 1:** Initialize vault → save `vaultAddress` and `lookupTableAddress`
- [ ] **Step 2:** Add Jupiter/Spot adaptor
- [ ] **Step 3:** Initialize Jupiter Earn strategy
- [ ] **Step 4:** Add Drift adaptor
- [ ] **Step 5:** Initialize Drift Earn strategy
- [ ] **Step 6:** Add Kamino adaptor
- [ ] **Step 7:** Initialize Kamino Market strategy
- [ ] **Step 8:** Deposit funds into vault
- [ ] **Step 9:** Configure and run the rebalance bot

---

## Resources

- **Hackathon Page:** [ranger.finance/build-a-bear-hackathon](https://ranger.finance/build-a-bear-hackathon)
- **Ranger Earn Docs:** [docs.ranger.finance](https://docs.ranger.finance)
- **Voltr Vault SDK:** [@voltr/vault-sdk](https://www.npmjs.com/package/@voltr/vault-sdk)
- **API:** `https://api.voltr.xyz`

### Source Repositories

| Repo | Purpose |
|------|---------|
| [voltrxyz/base-scripts](https://github.com/voltrxyz/base-scripts) | Vault init, deposit, withdraw |
| [voltrxyz/spot-scripts](https://github.com/voltrxyz/spot-scripts) | Jupiter/Spot adaptor + earn |
| [voltrxyz/drift-scripts](https://github.com/voltrxyz/drift-scripts) | Drift adaptor + earn |
| [voltrxyz/kamino-scripts](https://github.com/voltrxyz/kamino-scripts) | Kamino adaptor + market |
| [voltrxyz/rebalance-bot-template](https://github.com/voltrxyz/rebalance-bot-template) | Automated rebalancing bot |
