# Drift Protocol — Complete Technical Research

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [SDK Usage (TypeScript)](#2-sdk-usage-typescript)
3. [Drift Vaults Program](#3-drift-vaults-program)
4. [API Endpoints](#4-api-endpoints)
5. [Funding Rate Mechanics](#5-funding-rate-mechanics)
6. [Borrow/Lend Mechanics](#6-borrowlend-mechanics)
7. [Program IDs, Accounts, and Precision Constants](#7-program-ids-accounts-and-precision-constants)
8. [Vault Strategy: Basis Trade / Delta-Neutral / Funding Rate Harvesting](#8-vault-strategy-basis-trade--delta-neutral--funding-rate-harvesting)

---

## 1. Architecture Overview

### Core Protocol
Drift Protocol v2 is a decentralized exchange on Solana offering perpetual futures (up to 101x leverage), spot trading (up to 5x leverage), and borrow/lend — all within a **cross-margined risk engine**.

**Program ID (mainnet & devnet):** `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`

### Liquidity Trifecta
Three liquidity mechanisms work in priority order:
1. **JIT (Just-In-Time) Auctions** — Market makers fill orders within a short auction window
2. **Decentralized Limit Order Book (DLOB)** — On-chain resting limit orders matched by keeper bots
3. **vAMM (Virtual AMM)** — Backstop liquidity; always available at a price

### Cross-Margin Engine
- Margin is shared across all perpetual and spot positions within a user account
- Users can hold up to 32 sub-accounts under one authority
- Collateral for perps and spot is unified — holding SOL spot earns interest AND serves as perp margin

### Perpetual Markets
- Contract tiers: **A** (BTC), **B** (SOL, ETH), **C** (most markets), **Speculative**, **Highly Speculative**, **Isolated**
- Oracle sources: Pyth Network, Switchboard, Prelaunch (custom internal oracle)
- Each market has: max open interest, IMF factor (margin weight adjustment for large positions), funding rate caps

### Spot Markets
- Liquidity from both Drift DLOB and OpenBook DEX
- Each spot market doubles as a lending pool
- Deposits earn supply APY automatically
- Borrows pay borrow APY continuously
- Interest accrues directly to spot balances (auto-compounding)

### Key Account Types

| Account | Description |
|---------|-------------|
| **State** | Global protocol config (fees, risk params, admin) |
| **PerpMarket** | Per-market config: AMM params, funding, oracle, OI limits |
| **SpotMarket** | Per-market config: interest rates, oracle, mint, vault |
| **User** | Per-user positions, orders, collateral, margin state |
| **UserStats** | Per-authority aggregate stats |

---

## 2. SDK Usage (TypeScript)

### SDKs Available

| SDK | Package | GitHub |
|-----|---------|--------|
| TypeScript | `@drift-labs/sdk` | [drift-labs/protocol-v2/sdk](https://github.com/drift-labs/protocol-v2/tree/master/sdk) |
| Python | `driftpy` | [drift-labs/driftpy](https://github.com/drift-labs/driftpy) |
| Rust | `drift-rs` | [drift-labs/drift-rs](https://github.com/drift-labs/drift-rs) |

### Installation
```bash
npm i @drift-labs/sdk
```

### Wallet / Authentication

```bash
# Generate keypair
solana-keygen new --outfile ~/.config/solana/my-keypair.json

# Set environment variable
export ANCHOR_WALLET=~/.config/solana/my-keypair.json
```

```typescript
import { Wallet, loadKeypair } from "@drift-labs/sdk";

const keyPairFile = `${process.env.HOME}/.config/solana/my-keypair.json`;
const wallet = new Wallet(loadKeypair(keyPairFile));
```

### Initialization (Official Pattern)

```typescript
import { Connection } from "@solana/web3.js";
import { DriftClient, Wallet, loadKeypair } from "@drift-labs/sdk";

const connection = new Connection("<RPC_URL>", "confirmed");
const wallet = new Wallet(loadKeypair("<KEYPAIR_PATH>"));

const driftClient = new DriftClient({
  connection,
  wallet,
  env: "mainnet-beta",
});

await driftClient.subscribe();
```

### DriftClient Key Parameters

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `connection` | Solana RPC connection | Yes | |
| `wallet` | Wallet for signing transactions | Yes | |
| `env` | `devnet` or `mainnet-beta` | No | Derived |
| `perpMarketIndexes` | Perp markets to subscribe | No | All from env |
| `spotMarketIndexes` | Spot markets to subscribe | No | All from env |
| `accountSubscription` | WebSocket or polling mode | No | WebSocket |
| `activeSubAccountId` | Which subaccount to use | No | 0 |
| `subAccountIds` | All subaccounts to subscribe | No | [] |
| `authority` | Authority for delegated accounts | No | wallet.publicKey |

> **IMPORTANT for delegated accounts (vault trading):** When signing on behalf of a delegated account, you MUST explicitly set `subAccountIds`, `activeSubAccountId`, and `authority`. Omitting any will cause the client to subscribe to the wrong accounts.

### Polling Subscription (Recommended for Bots)

```typescript
import { BulkAccountLoader } from "@drift-labs/sdk";

const accountLoader = new BulkAccountLoader(connection, "confirmed", 0);

const driftClient = new DriftClient({
  connection,
  wallet,
  env: "mainnet-beta",
  accountSubscription: {
    type: "polling",
    accountLoader,
  },
});
```

### Multiple Subaccounts

Drift supports up to 32 subaccounts per wallet, each with isolated positions and orders:

```typescript
if (!driftClient.hasUser(1)) {
  await driftClient.addUser(1); // subscribe to subaccount 1
}
```

### User Account Initialization

```typescript
// Check if user exists, create with initial USDC deposit if not
if (!(await driftClient.hasUser())) {
  await driftClient.initializeUserAccountAndDepositCollateral(
    new BN(10).mul(QUOTE_PRECISION), // 10 USDC
    userUSDCTokenAccount,
    0, // marketIndex for USDC = 0
  );
}
```

### Placing Orders

```typescript
// Market order — long SOL-PERP
await driftClient.placePerpOrder({
  orderType: OrderType.MARKET,
  marketType: MarketType.PERP,
  marketIndex: 0, // SOL-PERP
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1), // 1 SOL
});

// Limit order — short ETH-PERP
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketType: MarketType.PERP,
  marketIndex: 1, // ETH-PERP
  direction: PositionDirection.SHORT,
  baseAssetAmount: driftClient.convertToPerpPrecision(0.5),
  price: driftClient.convertToPricePrecision(2500),
  postOnly: true,
});

// Place multiple orders atomically
await driftClient.placeOrders([orderParams1, orderParams2]);

// Cancel and place atomically
await driftClient.cancelAndPlaceOrders(cancelParams, [newOrderParams]);

// Modify existing order
await driftClient.modifyOrder({ orderId, baseAssetAmount, price });
```

### Order Types
- `MARKET` — Immediate execution at current market price
- `LIMIT` — Execution at specified price or better
- `TRIGGER_MARKET` — Stop/take-profit market order
- `TRIGGER_LIMIT` — Stop/take-profit limit order
- `ORACLE` — Market order using oracle price offset

### Position & Account Queries

```typescript
const user = driftClient.getUser();

// Perp position
const perpPosition = user.getPerpPosition(0); // SOL-PERP
console.log('Base:', convertToNumber(perpPosition.baseAssetAmount, BASE_PRECISION));

// Spot position (token balance)
const spotPosition = user.getSpotPosition(0); // USDC
const tokenAmount = user.getTokenAmount(0);

// Risk metrics
const unrealizedPnl = user.getUnrealizedPNL();
const fundingPnl = user.getUnrealizedFundingPNL();
const totalCollateral = user.getTotalCollateral();
const freeCollateral = user.getFreeCollateral();
const leverage = user.getLeverage();
const marginRequirement = user.getMarginRequirement();

// Open orders
const openOrders = user.getOpenOrders();
const specificOrder = user.getOrder(orderId);
```

### Market Data

```typescript
// Get perp market account
const perpMarket = driftClient.getPerpMarketAccount(0); // SOL-PERP

// Get oracle price
const oracleData = driftClient.getOracleDataForPerpMarket(0);
console.log('Oracle price:', convertToNumber(oracleData.price, PRICE_PRECISION));

// Calculate vAMM bid/ask
const { bid, ask } = calculateBidAskPrice(perpMarket.amm, oracleData);

// Get all markets
const allPerpMarkets = driftClient.getPerpMarketAccounts();
const allSpotMarkets = driftClient.getSpotMarketAccounts();
```

### Deposits & Withdrawals

```typescript
// Deposit USDC
await driftClient.deposit(
  new BN(100).mul(QUOTE_PRECISION), // 100 USDC
  0, // USDC market index
  userUSDCTokenAccount,
);

// Deposit SOL
await driftClient.deposit(
  new BN(5).mul(new BN(10).pow(new BN(9))), // 5 SOL
  1, // SOL market index
  userSOLTokenAccount,
);

// Withdraw
await driftClient.withdraw(
  new BN(50).mul(QUOTE_PRECISION),
  0,
  userUSDCTokenAccount,
);
```

### Funding Rate Operations

```typescript
// Settle accumulated funding payments
await driftClient.settleFundingPayment();

// Update funding rate for a market (keeper operation)
await driftClient.updateFundingRate(0); // SOL-PERP market index

// Get funding PnL
const fundingPnl = user.getUnrealizedFundingPNL();
```

### Event Subscription

```typescript
// Subscribe to events
const eventSubscriber = new EventSubscriber(connection, driftClient.program, {
  eventTypes: [
    'DepositRecord',
    'FundingPaymentRecord',
    'FundingRateRecord',
    'OrderRecord',
    'OrderActionRecord',
    'LiquidationRecord',
    'SettlePnlRecord',
    'SpotInterestRecord',
  ],
});
await eventSubscriber.subscribe();
```

### Key DriftClient Methods Reference

| Category | Methods |
|----------|---------|
| **Orders** | `placePerpOrder`, `placeSpotOrder`, `placeOrders`, `cancelOrder`, `cancelOrders`, `modifyOrder`, `cancelAndPlaceOrders`, `placeAndTakePerpOrder`, `placeAndMakePerpOrder` |
| **Positions** | `openPosition`, `closePosition`, `getSpotPosition` |
| **Funding** | `settleFundingPayment`, `updateFundingRate`, `getSettleFundingPaymentIx` |
| **Settlement** | `settlePNL`, `settlePNLs`, `settleLP`, `settleExpiredMarket` |
| **Deposits** | `deposit`, `withdraw`, `transferDeposit` |
| **Account** | `getUser`, `getUserAccount`, `hasUser`, `initializeUserAccount`, `switchActiveUser`, `addUser`, `deleteUser` |
| **Market Data** | `getPerpMarketAccount`, `getSpotMarketAccount`, `getOracleDataForPerpMarket`, `getOracleDataForSpotMarket`, `getStateAccount` |
| **LP** | `addPerpLpShares`, `removePerpLpShares` |
| **Insurance** | `addInsuranceFundStake`, `removeInsuranceFundStake` |
| **Utility** | `convertToPerpPrecision`, `convertToPricePrecision`, `convertToSpotPrecision` |

---

## 3. Drift Vaults Program

### Overview
The Drift Vaults program allows fund managers to create on-chain vaults that pool depositor capital and trade on Drift via delegated authority. It is built on top of protocol-v2.

**Vaults Program ID (mainnet):** `vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR`

### Installation

```bash
# Vaults SDK
npm i @drift-labs/vaults-sdk

# Also requires the core SDK
npm i @drift-labs/sdk
```

### Architecture

```
┌──────────────────┐     CPI calls     ┌───────────────────────┐
│  Drift Vaults    │ ──────────────────>│  Drift Protocol v2    │
│  Program         │                    │  (dRifty...)          │
│  (vAuLT...)      │                    │                       │
├──────────────────┤                    ├───────────────────────┤
│ Vault Account    │                    │ User Account          │
│ VaultDepositor   │                    │ PerpMarket            │
│ VaultProtocol    │                    │ SpotMarket            │
│ FeeUpdate        │                    │ State                 │
│ TokenizedVaultDep│                    │                       │
└──────────────────┘                    └───────────────────────┘
```

### Account Structures

#### Vault Account (PDA derived from vault name)
```
name: [u8; 32]              — Vault identifier (unique)
manager: Pubkey              — Manager authority
delegate: Pubkey             — Trading delegate (can be same as manager)
tokenAccount: Pubkey         — SPL token vault
driftUser: Pubkey            — Drift protocol user account
driftUserStats: Pubkey       — Performance tracking
userShares: u128             — Total depositor shares
totalShares: u128            — Total outstanding shares (includes manager)
managementFee: i64           — Annual % (scaled, 1e6 precision)
profitShare: u32             — Performance fee % on profits
hurdleRate: u32              — Minimum return threshold before profit share
redeemPeriod: i64            — Withdrawal waiting period (seconds)
maxTokens: u64               — Capacity limit
permissioned: bool           — Whitelist required
vaultProtocol: bool          — Protocol fee layer enabled
marginTradingEnabled: bool   — Leverage trading allowed
liquidationStartTs: i64      — Emergency mode timestamp
```

#### VaultDepositor Account
```
vault: Pubkey                — Parent vault
authority: Pubkey            — Depositor's wallet
vaultShares: u128            — Share balance
netDeposits: i64             — Cumulative net deposits
totalDeposits: u64           — Lifetime deposits
totalWithdraws: u64          — Lifetime withdrawals
lastWithdrawRequest: WithdrawRequest  — Pending withdrawal state
cumulativeProfitShareAmount: i64      — Total profit fees paid
```

#### Share-Based Accounting
```
Share Price     = Vault Equity / Total Shares
New Shares      = Deposit Amount / Share Price
Depositor Value = (Depositor Shares / Total Shares) × Vault Equity
```

### Fee Structure

| Fee Type | Mechanics |
|----------|-----------|
| **Management Fee** | Annual % on AUM; applied as share dilution (manager gets new shares) |
| **Profit Share** | % of profits above hurdle rate; per-depositor watermark prevents double-charging |
| **Protocol Fee** | Optional additional annual % (if VaultProtocol enabled) |

Fees are realized during deposits, withdrawals, and explicit `applyProfitShare` calls.

### Withdrawal Mechanics (Two-Phase)

1. **Request**: Call `requestWithdraw(amount, unit)` — unit can be `Token`, `Shares`, or `SharesPercent`
2. **Wait**: `redeemPeriod` must elapse (default 7 days, configurable)
3. **Execute**: Call `withdraw()` — tokens transferred, shares burned

### Vault Manager CLI

```bash
# Create a new vault (USDC deposit, market-index 0)
yarn cli init-vault \
  --name "My Basis Trade Vault" \
  --market-index 0 \
  --redeem-period 3600 \
  --max-tokens 1000000 \
  --management-fee 2 \
  --profit-share 20 \
  --min-deposit-amount 100

# Enable margin trading (required for perps)
yarn cli manager-update-margin-trading-enabled \
  --vault-address=<VAULT_ADDRESS> \
  --enabled=true

# Manager deposit
yarn cli manager-deposit --vault-address=<VAULT_ADDRESS> --amount=10000

# Update vault parameters
yarn cli manager-update-vault --vault-address=<VAULT_ADDRESS> --redeem-period 7200

# View vault state
yarn cli view-vault --vault-address=<VAULT_ADDRESS>

# Apply profit share to all depositors
yarn cli apply-profit-share-all --vault-address=<VAULT_ADDRESS>
```

### VaultClient SDK Usage

```typescript
import { VaultClient } from '@drift-labs/vaults-sdk';
import { DriftClient } from '@drift-labs/sdk';

// Initialize
const vaultClient = new VaultClient(driftClient, vaultProgram);

// Create vault
const initVaultIx = await vaultClient.getInitializeVaultIx({
  name: encodeName('My Vault'),
  spotMarketIndex: 0,  // USDC
  redeemPeriod: new BN(3600),
  maxTokens: new BN(1_000_000).mul(QUOTE_PRECISION),
  managementFee: new BN(20_000), // 2% (1e6 precision)
  profitShare: 200_000, // 20%
  hurdleRate: 0,
  permissioned: false,
});

// Deposit as depositor
await vaultClient.deposit(depositAmount, vaultAddress, vaultDepositorAddress);

// Request withdrawal
await vaultClient.requestWithdraw(amount, WithdrawUnit.Token, vaultAddress, vaultDepositorAddress);

// Execute withdrawal (after redeem period)
await vaultClient.withdraw(vaultAddress, vaultDepositorAddress);

// Calculate vault equity
const equity = await vaultClient.calculateVaultEquity(vault);

// Calculate depositor equity
const depositorEquity = vaultClient.calculateVaultDepositorEquity(vaultDepositor, vault);
```

### Vault Manager Trading (via DriftClient as delegate)

Once the vault's delegate is set to the manager's keypair, the manager trades using the vault's Drift user account:

```typescript
// The manager's DriftClient is initialized with the delegate keypair
// and configured to act on the vault's Drift user account

// Place perp order on behalf of vault
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketType: MarketType.PERP,
  marketIndex: 0, // SOL-PERP
  direction: PositionDirection.SHORT,
  baseAssetAmount: driftClient.convertToPerpPrecision(100),
  price: driftClient.convertToPricePrecision(150),
  subAccountId: vaultSubAccountId,
});
```

### 49 Program Instructions (Grouped)

| Group | Instructions |
|-------|-------------|
| **Init & Config** | `initializeVault`, `initializeVaultWithProtocol`, `updateVault`, `updateVaultManager`, `updateDelegate`, `updateMarginTradingEnabled` |
| **Depositor** | `initializeVaultDepositor`, `deposit`, `requestWithdraw`, `cancelRequestWithdraw`, `withdraw`, `liquidate`, `forceWithdraw` |
| **Manager** | `managerDeposit`, `managerBorrow`, `managerRepay`, `managerUpdateBorrow`, `managerRequestWithdraw`, `managerCancelWithdrawRequest`, `managerWithdraw` |
| **Fees** | `adminInitFeeUpdate`, `adminDeleteFeeUpdate`, `managerUpdateFees`, `managerCancelFeeUpdate`, `applyProfitShare` |
| **Tokenization** | `initializeTokenizedVaultDepositor`, `tokenizeShares`, `redeemTokens` |
| **Insurance Fund** | `initializeInsuranceFundStake`, `addInsuranceFundStake`, `requestRemoveInsuranceFundStake`, `removeInsuranceFundStake`, `cancelRequestRemoveInsuranceFundStake` |
| **Protocol** | `protocolRequestWithdraw`, `protocolCancelWithdrawRequest`, `protocolWithdraw` |
| **Maintenance** | `applyRebase`, `resetDelegate`, `updateCumulativeFuelAmount` |

---

## 4. API Endpoints

### Self-Hosted Gateway (REST)

The Drift Gateway is a Rust-based self-hosted API server.

**GitHub:** `drift-labs/gateway`

```bash
# Run with Docker
docker run -e DRIFT_GATEWAY_KEY=<BASE58_SEED> -p 8080:8080 \
  ghcr.io/drift-labs/gateway \
  https://api.mainnet-beta.solana.com \
  --host 0.0.0.0 --markets sol-perp,sol,weth

# Run from source
export DRIFT_GATEWAY_KEY=/path/to/keypair.json
drift-gateway https://your-rpc.com --markets sol-perp,wbtc
```

#### Gateway REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/markets` | All tradable spot and perp markets |
| GET | `/v2/positions` | Current spot and perp positions |
| GET | `/v2/orders` | Active orders |
| POST | `/v2/orders` | Place new orders |
| PATCH | `/v2/orders` | Modify orders |
| DELETE | `/v2/orders` | Cancel orders |
| PUT | `/v2/orders` | Atomic cancel+place+modify |
| GET | `/v2/user/marginInfo` | Margin requirements |
| GET | `/v2/leverage` | Current leverage |
| POST | `/v2/leverage` | Set max leverage |
| GET | `/v2/collateral` | Collateral status |
| POST | `/v2/swap` | Jupiter spot swap |

**Order placement format:**
```json
{
  "marketIndex": 0,
  "marketType": "perp",
  "amount": 1.5,
  "price": 150.0,
  "orderType": "limit",
  "postOnly": true,
  "direction": "short",
  "reduceOnly": false
}
```

**Transaction control query params:** `?ttl=2&computeUnitLimit=300000&computeUnitPrice=1000&subAccountId=0`

**Delegated mode:** `drift-gateway --delegate <DELEGATOR_PUBKEY> https://rpc-url`

### Data API (Hosted by Drift)

**Base URL:** `https://data.api.drift.trade`

**OpenAPI spec:** `https://data.api.drift.trade/playground/json`

#### Key Data API Endpoints

**Funding Rates:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/market/{symbol}/fundingRates` | Paginated funding rates (20-750 records) |
| GET | `/market/{symbol}/fundingRates/{year}/{month}/{day}` | Historical funding rates by date |

Response fields: `fundingRate`, `fundingRateLong`, `fundingRateShort`, `cumulativeFundingRateLong`, `cumulativeFundingRateShort`, `oraclePriceTwap`, `markPriceTwap`, `periodRevenue`, `baseAssetAmountWithAmm`

**Interest/Borrow Rates:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/stats/{symbol}/rateHistory/{type}` | Rate history (types: deposit, borrow, deposit_balance, borrow_balance) |

**Market Data:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/stats/markets` | All markets: prices, volumes, funding rates |
| GET | `/stats/markets/volume/{interval}` | Rolling volume (1h, 24h, 30d) |
| GET | `/stats/markets/prices` | 24h price changes |
| GET | `/stats/fundingRates` | Average funding rates across time periods |
| GET | `/market/{symbol}/candles/{resolution}` | OHLC data (1, 5, 15, 60, 240, D, W, M) |
| GET | `/market/{symbol}/trades` | Trade records (50/req, 31-day history) |

**AMM Data:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/amm/position` | AMM inventory |
| GET | `/amm/bidAskPrice` | AMM bid/ask spreads |
| GET | `/amm/oraclePrice` | Oracle price data |
| GET | `/amm/openInterest` | Open interest data |

**User/Authority Data:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/authority/{id}/snapshots/overview` | Multi-product overview (7d default) |
| GET | `/authority/{id}/snapshots/trading` | Trading snapshots |
| GET | `/authority/{id}/snapshots/vaults` | Vault snapshots |
| GET | `/authority/{id}/accounts` | Drift user accounts (BETA) |

**Vaults:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/stats/vaults` | All vault data and metrics |

**Common query params:** `page`, `limit`, `format` (json/csv), `startTs`, `endTs` (unix seconds), `samples` (max 11,000)

### DLOB Server (WebSocket + REST)

**Public WebSocket endpoints:**
- Mainnet: `wss://dlob.drift.trade/ws`
- Devnet: `wss://master.dlob.drift.trade/ws`

**Subscribe to orderbook:**
```json
{
  "action": "subscribe",
  "channel": "orderbook",
  "marketIndex": 0,
  "marketType": "perp"
}
```

**L2/L3 Orderbook REST:**
```
GET /l2?marketIndex=0&marketType=perp
GET /l3?marketIndex=0&marketType=perp
GET /topMakers?marketIndex=0&marketType=perp&side=bid&limit=5
```

### Data API WebSocket

```
wss://data.api.drift.trade/ws
```

Subscribe to channels: `candle`, `markets`, `pricing`, `orderbook`, `user`, `notifications`

### Historical Data (AWS S3)

**Prefix:** `https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com/program/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH/`

Note: S3 flat files were deprecated January 2025. Use the Data API endpoints instead.

---

## 5. Funding Rate Mechanics

### Calculation Formula

```
Hourly Funding Rate = (1/24) × (mark_twap - oracle_twap) / oracle_twap
```

- **EMA span:** 1 hour
- **Mark TWAP:** `(bid_twap + ask_twap) / 2`
- **Update frequency:** End of each hour (9:00, 10:00, etc.)
- **Lazy updates:** Triggered when users open/close positions; if no activity for ~20 minutes past the hour, the next update delays an additional hour

### Who Pays Whom
- When mark > oracle (positive rate): **longs pay shorts**
- When mark < oracle (negative rate): **shorts pay longs**

### Rate Clamping (per hour)

| Contract Tier | Max Hourly Magnitude |
|---------------|---------------------|
| **B or greater** (BTC, SOL, ETH) | 0.125% |
| **C** | 0.208% |
| **Below C** | 0.4167% |

Clamping can be delayed during large oracle divergences.

### Symmetric Funding & Rebate Pool
When there is a long-short imbalance in the AMM, the market-specific **Rebate Pool** covers the difference between what longs pay and shorts receive (or vice versa). If the pool has less than 2/3 of its available balance, funding receipts are capped to available amounts.

### Settlement
- Funding payments initially appear as **Unrealized PnL**
- Settlement is triggered by user activity (trades, deposits, withdrawals)
- Cumulative funding rate is checked against user positions even if the off-chain bot doesn't trigger on time

### APR/APY Conversion
```
APR = rate × 24 × 365.25
APY = (1 + rate)^(24 × 365.25) - 1
```

### Querying Funding Rates

**Via Data API:**
```
GET https://data.api.drift.trade/market/SOL-PERP/fundingRates?limit=100
```

Response includes: `fundingRate` (in quote/base units — divide by `oraclePriceTwap` for percentage), `fundingRateLong`, `fundingRateShort`, `oraclePriceTwap`, `markPriceTwap`

**Via SDK:**
```typescript
const perpMarket = driftClient.getPerpMarketAccount(0);
// Access: perpMarket.amm.lastFundingRate
// Access: perpMarket.amm.cumulativeFundingRateLong
// Access: perpMarket.amm.cumulativeFundingRateShort
// Access: perpMarket.amm.lastFundingRateTs
```

**Via Event Subscription:**
Subscribe to `FundingRateRecord` and `FundingPaymentRecord` events.

---

## 6. Borrow/Lend Mechanics

### Interest Rate Model
Drift uses a **multi-kink model** inspired by Aave. The borrow rate is a function of utilization U = Total Borrowed / Total Deposits.

### Rate Curve Parameters (per spot market)
Each spot market defines:
- **R_min** — Floor interest rate
- **R_opt** — Target rate at optimal utilization U*
- **R_max** — Ceiling rate at full utilization

### Multi-Kink Rate Bands

| Utilization Range | Behavior |
|-------------------|----------|
| U ≤ U* | Linear ramp from R_min to R_opt |
| U* to 0.85 | Mild penalty (+50 bps above R_opt) |
| 0.85 to 0.90 | Steeper (+100 bps) |
| 0.90 to 0.95 | Steeper still (+150 bps) |
| 0.95 to 0.99 | Aggressive (+200 bps) |
| 0.99 to 0.995 | Near-vertical (+250 bps) |
| 0.995 to 1.00 | Maximum (+250 bps) |

### Supply APY
```
Supply APY = Borrow APY × Utilization Ratio
```
Supply APY auto-compounds continuously. Interest accrues directly to the spot balance.

### Key Points for Strategy
- Borrowing has no fixed repayment deadline
- Interest on borrows is paid continuously to spot balances
- Cross-margin: deposits earn interest while simultaneously serving as collateral for perps
- Borrow rates spike aggressively above 85% utilization — strategy must monitor this

### Querying Borrow/Lend Rates

**Via Data API:**
```
GET https://data.api.drift.trade/stats/SOL/rateHistory/borrow
GET https://data.api.drift.trade/stats/SOL/rateHistory/deposit
```

**Via SDK:**
```typescript
const spotMarket = driftClient.getSpotMarketAccount(1); // SOL
// Access rate parameters from spotMarket account
// spotMarket.optimalUtilization
// spotMarket.optimalBorrowRate
// spotMarket.maxBorrowRate
```

---

## 7. Program IDs, Accounts, and Precision Constants

### Program IDs

| Program | Address |
|---------|---------|
| **Drift Protocol v2** | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` |
| **Drift Vaults** | `vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR` |

### IDL Files
- **Protocol v2 IDL:** Located at `programs/drift/src/idl/` in the protocol-v2 repo, or fetch via Anchor: `anchor idl fetch dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
- **Vaults IDL:** Located at `programs/drift_vaults/` in the drift-vaults repo

### Precision Constants

| Value | Precision | Constant Name |
|-------|-----------|---------------|
| Perp base amount | 1e9 | `BASE_PRECISION` |
| Perp quote amount | 1e6 | `QUOTE_PRECISION` |
| Price | 1e6 | `PRICE_PRECISION` |
| Funding rate | 1e9 | `FUNDING_RATE_PRECISION` |
| Spot token balance | 1e9 | `SPOT_MARKET_BALANCE_PRECISION` |
| Margin ratio | 1e4 | `MARGIN_PRECISION` |
| AMM reserves | 1e9 | `AMM_RESERVE_PRECISION` |
| Fee/percentage | 1e6 | `PERCENTAGE_PRECISION` |

### Key Market Indices

| Market | Type | Index |
|--------|------|-------|
| USDC | Spot | 0 |
| SOL | Spot | 1 |
| SOL-PERP | Perp | 0 |
| BTC-PERP | Perp | 1 |
| ETH-PERP | Perp | 2 |

### Contract Tiers

| Tier | Markets | Funding Cap/hr |
|------|---------|---------------|
| A | BTC-PERP | 0.125% |
| B | SOL-PERP, ETH-PERP | 0.125% |
| C | Most markets | 0.208% |
| Speculative | 1MBONK, 1MPEPE, WIF | 0.4167% |
| Highly Speculative | W-PERP | 0.4167% |
| Isolated | Restricted to isolated margin | 0.4167% |

---

## 8. Vault Strategy: Basis Trade / Delta-Neutral / Funding Rate Harvesting

### Strategy Overview
A delta-neutral funding rate harvesting strategy profits from the spread between perpetual funding rates and spot holding/borrowing costs, while maintaining zero directional exposure.

### Core Logic

**When funding rate is positive (longs pay shorts):**
1. Hold spot asset (e.g., SOL) as collateral → earns lending APY
2. Short perp (e.g., SOL-PERP) with equivalent notional → collects funding

**When funding rate is negative (shorts pay longs):**
1. Borrow and sell spot asset → pays borrow APY
2. Long perp with equivalent notional → collects funding

**Profit = |Funding Rate APY| - Borrow/Opportunity Cost APY - Trading Fees**

### Reference Implementation: drift-funding-arb

The `drift-labs/drift-funding-arb` repo (Rust) implements this exact strategy:

```
1. Initialize Drift account with USDC collateral
2. Fetch current market data
3. Calculate funding rate APY: (1 + rate)^(24 × 365.25) - 1
4. Calculate spot borrow APR from protocol math
5. Compare: if funding APY > borrow APR, enter position
6. Direction: if mark < oracle (longs paid) → go long perp + borrow/sell spot
             if mark > oracle (shorts paid) → go short perp + hold spot
7. Monitor and exit when funding no longer favorable
```

CLI: `drift-funding-arb -k keypair.json -t <position_size> --perp-market-index 0 --spot-market-index 1`

### Implementation with Drift Vault

```typescript
// === VAULT CREATION ===
// Create vault that accepts USDC deposits
const initVaultIx = await vaultClient.getInitializeVaultIx({
  name: encodeName('Basis Trade Vault'),
  spotMarketIndex: 0,      // USDC deposits
  redeemPeriod: new BN(86400), // 24h redeem period
  maxTokens: new BN(1_000_000).mul(QUOTE_PRECISION),
  managementFee: new BN(20_000),  // 2%
  profitShare: 200_000,            // 20%
  hurdleRate: 0,
  permissioned: false,
});

// Enable margin trading for the vault
await vaultClient.updateMarginTradingEnabled(vaultAddress, true);

// === STRATEGY EXECUTION (as vault delegate) ===

// 1. Check funding rate
const perpMarket = driftClient.getPerpMarketAccount(0); // SOL-PERP
const oracleData = driftClient.getOracleDataForPerpMarket(0);
const lastFundingRate = perpMarket.amm.lastFundingRate;
const fundingRateAPY = Math.pow(
  1 + convertToNumber(lastFundingRate, FUNDING_RATE_PRECISION),
  24 * 365.25
) - 1;

// 2. Check borrow rate for spot
const spotMarket = driftClient.getSpotMarketAccount(1); // SOL spot
// Calculate current borrow APR from spot market parameters

// 3. If profitable, enter delta-neutral position
if (fundingRateAPY > borrowAPR + tradingFees) {

  // Positive funding: short perp + buy spot
  if (fundingRate > 0) {
    // Buy SOL spot
    await driftClient.deposit(solAmount, 1, solTokenAccount);

    // Short SOL-PERP with matching notional
    await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: 0,
      direction: PositionDirection.SHORT,
      baseAssetAmount: solAmount, // Matching base amount
    });
  }

  // Negative funding: long perp + short/borrow spot
  else {
    // Short SOL spot (borrow + sell)
    await driftClient.withdraw(solAmount, 1, solTokenAccount);

    // Long SOL-PERP
    await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: 0,
      direction: PositionDirection.LONG,
      baseAssetAmount: solAmount,
    });
  }
}

// 4. Periodically settle funding
await driftClient.settleFundingPayment();

// 5. Monitor and rebalance
const user = driftClient.getUser();
const perpPos = user.getPerpPosition(0);
const spotPos = user.getSpotPosition(1);
const fundingPnl = user.getUnrealizedFundingPNL();
```

### Monitoring Endpoints for Strategy

```
# Current funding rates
GET https://data.api.drift.trade/stats/fundingRates

# Historical funding rate for SOL-PERP
GET https://data.api.drift.trade/market/SOL-PERP/fundingRates?limit=750

# Current borrow/supply rates
GET https://data.api.drift.trade/stats/SOL/rateHistory/borrow
GET https://data.api.drift.trade/stats/SOL/rateHistory/deposit

# Market overview (OI, volume, prices)
GET https://data.api.drift.trade/stats/markets

# Vault performance
GET https://data.api.drift.trade/stats/vaults
```

### Risk Considerations

1. **Funding rate reversal** — Rate can flip direction; monitor hourly and have exit logic
2. **Borrow rate spikes** — Above 85% utilization, borrow rates spike aggressively (multi-kink model)
3. **Liquidation risk** — Even delta-neutral positions can be liquidated if funding losses exceed margin
4. **Oracle divergence** — Temporary oracle issues can cause incorrect funding calculations
5. **Rebalancing costs** — Trading fees on entry/exit (taker fees on Drift)
6. **Spot price slippage** — Large positions may suffer slippage on spot leg
7. **Withdrawal pressure** — Vault must maintain liquidity for depositor withdrawals (redeemPeriod helps)
8. **Funding rate clamping** — Rates are capped per contract tier, limiting maximum yield

### Typical Yield Profile
- Funding rates typically range from 0.001% to 0.1% per 8 hours on Drift
- Annualized: ~1% to ~40% APY depending on market conditions
- Net yield after borrow costs: highly variable, most attractive during bull markets with high perp premiums

---

## Source Links

- [Drift Protocol Documentation](https://docs.drift.trade/)
- [Drift Protocol v2 GitHub](https://github.com/drift-labs/protocol-v2)
- [Drift Vaults GitHub](https://github.com/drift-labs/drift-vaults)
- [Drift Gateway GitHub](https://github.com/drift-labs/gateway)
- [Drift Funding Arb Bot](https://github.com/drift-labs/drift-funding-arb)
- [Drift Funding Vault (0xNineteen)](https://github.com/0xNineteen/drift-funding-vault)
- [SDK TypeScript API Docs](https://drift-labs.github.io/protocol-v2/sdk/)
- [DriftClient Class Reference](https://drift-labs.github.io/protocol-v2/sdk/classes/DriftClient.html)
- [Protocol v2 API (v2-teacher)](https://drift-labs.github.io/v2-teacher/)
- [Data API Playground](https://data.api.drift.trade)
- [Data API Glossary](https://docs.drift.trade/developers/data-api/glossary)
- [Funding Rates Documentation](https://docs.drift.trade/trading/funding-rates)
- [Borrow Interest Rate Documentation](https://docs.drift.trade/lend-borrow/borrow-interest-rate)
- [Supply & Borrow APY Documentation](https://docs.drift.trade/lend-borrow/supply-borrow-apy)
- [Market Specifications](https://docs.drift.trade/trading/market-specs)
- [DLOB Server GitHub](https://github.com/drift-labs/dlob-server)
- [Drift Vaults DeepWiki](https://deepwiki.com/drift-labs/drift-vaults)
- [npm: @drift-labs/sdk](https://www.npmjs.com/package/@drift-labs/sdk)
- [npm: @drift-labs/vaults-sdk](https://www.npmjs.com/package/@drift-labs/vaults-sdk)
