# On-Chain Programs & Verified Deployments

## Deployed Anchor Programs

### 1. DriftBear Custom Adaptor (Production)

**Program ID:** `4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ`
**Source:** `src/plugins/driftbear-adaptor/programs/driftbear_custom_adaptor/src/lib.rs`
**Lines:** 1,059 lines of Rust
**Status:** Deployed on devnet, verified working with real transactions

#### What It Does

Custom Anchor adaptor that performs CPI (Cross-Program Invocation) to Drift Protocol v2 for vault-managed strategy execution:

- `initialize()` — Sets up position PDA for a vault strategy, validates Drift user accounts, locks subaccount
- `deposit(amount)` — Deposits USDC into Drift via CPI, tracks balance in position PDA
- `withdraw(amount)` — Withdraws USDC from Drift via CPI, updates tracked balance
- `migrate_position()` — Migrates legacy position data with account realloc support

#### On-Chain Safety

The program validates **every account** before CPI:
- Verifies Drift program ID matches mainnet (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`)
- Validates user PDA derivation (authority + sub_account_id)
- Checks no open orders, no perp exposure, no borrow positions
- Rejects if user is being liquidated or bankrupt
- Validates spot market mint matches vault asset mint
- Validates spot market vault matches provided account

#### Verified Devnet Transactions

| Action | Transaction Signature |
|---|---|
| Initialize | `3o8rLDXGQUyyyqLYJuMwAKaw6XE85wKk3DwcS5shDFH9BJP7s63L7HMjFGA2ajgWpq65H1AtUu1E6eDyFBaTDfTn` |
| Deposit 1 USDC | `5C1eN2yctzq4B2th7j3eszZ3ymy5kbGYGr8hmcUKY3CqEbpNpnKMTZDH4haCX3F7Y4dYXFVXG1M7VjemspLxYBjv` |
| Withdraw 0.5 USDC | `vp7hBrvnCqL5QVU4YWFanaE2huRRpm9Nri9pb9FM3RRM61ECZdg68HAFbbXQLnce1yaTpeHoiei1xrzuaAbXJXc` |
| Position Migrate | `3drRLrfRD6XG81Sos8C49DveZMG9hFnFRuS5L8XUoLvRgsS16pMZ3tidudmYGUrKNwEcgcEWzTD7m3zp9dLq7HJP` |

#### Devnet Addresses

| Account | Address |
|---|---|
| Wallet | `CnCAtrN1sMaTEQJfGQj5DNuBcZf4ibhYUYeAgBfBtYPL` |
| Vault | `GRQrzTzz55Kd59uFSmW8mvkzUhzVTLCdjHGP4hnbxCna` |
| Strategy | `FJvUxNw6BdvApP3e5wDXjrfLn7pGCUrWx7hxWiHLk4mY` |
| Drift User | `2xe1yY4tNcnzESvcKER8PHX3m3SKP74HHDNf2iQf5CZh` |
| Drift User Stats | `B9RE8Nv8zTHcboZijGTsANjgHDQz5sGQ21KvLdqTWe6X` |
| Spot Market (USDC) | `6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3` |
| Drift Signer | `JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw` |
| Current Drift Deposit | 20 USDC |

### 2. Mock CToken Market

**Program ID:** `DPk5Ptke7pfV64sn3RtqQjYGCNYwtA6vmENxXakVfwpJ`
**Source:** `src/plugins/driftbear-adaptor/programs/mock_ctoken_market/src/lib.rs`
**Status:** Deployed on devnet

Simple AMM for testing deposit/withdrawal mechanics:
- `initialize_market_and_user()` — Create market with cToken mint
- `deposit_market()` — Deposit liquidity tokens, mint cTokens
- `withdraw_market()` — Burn cTokens, withdraw liquidity

### 3. Drift Vaults Program (Reference)

**Program ID:** `vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR`
**Source:** `src/plugins/drift-vaults/programs/drift_vaults/src/lib.rs`
**Status:** Reference (deployed on mainnet by Drift Labs)

Full vault lifecycle: initialize, deposit, withdraw, tokenized shares, profit sharing, insurance fund staking.

## Additional Rust Code in Repository

| Component | Location | Lines | Purpose |
|---|---|---|---|
| Drift Gateway | `src/plugins/gateway/src/` | ~2K | Rust HTTP gateway for fast order execution |
| Keep-RS | `src/plugins/keep-rs/src/` | 4,196 | Rust keeper (filler + liquidator) |
| Drift-RS SDK | `src/plugins/drift-rs/` | ~5K | Rust SDK for Drift v2 |
| Swift TX Server | `src/plugins/swift/` | ~1K | Fast transaction submission |
| Raydium CLMM | `src/plugins/raydium-clmm/programs/` | 54 files | Concentrated liquidity AMM |

## Architecture: On-Chain + Off-Chain

```
┌─────────────────────────────────────────────────────────┐
│                    ON-CHAIN (Solana)                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Ranger Earn Vault (Voltr)                             │
│       │                                                 │
│       ▼                                                 │
│  DriftBear Custom Adaptor ←── Our Anchor Program       │
│  (4JW3mvrVGX...)           (1,059 lines Rust)          │
│       │                                                 │
│       ▼ CPI                                            │
│  Drift Protocol v2                                      │
│  (dRiftyHA39...)                                        │
│       │                                                 │
│       ├── Perp Markets (SOL/BTC/ETH/JTO/INJ)           │
│       ├── Spot Markets (USDC/SOL/BTC/ETH)              │
│       ├── DLOB (limit orders, JIT auctions)            │
│       └── Oracle (Pyth/Switchboard)                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│                   OFF-CHAIN (TypeScript)                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Strategy Engine (engine.ts)                           │
│       ├── LLM Regime Detection (Claude)                │
│       ├── Funding Rate Predictor (EMA/TWAP)            │
│       ├── Circuit Breaker (6 triggers)                 │
│       ├── Risk Manager (health/drawdown/leverage)      │
│       └── Oracle Guard (staleness/spread)              │
│                                                         │
│  Execution Layer                                        │
│       ├── JIT Maker (slot-based auction fills)         │
│       ├── Filler Bot (DLOB order matching)             │
│       ├── FloatingMaker (oracle-offset market making)  │
│       ├── Drift Executor (atomic txs, Jito bundles)   │
│       └── Ranger SOR (cross-venue routing)             │
│                                                         │
│  Intelligence Layer                                     │
│       ├── Ranger Data API (funding arbs, liquidations) │
│       ├── DLOB L2 Orderbook (price impact)             │
│       ├── Sanctum LST APY (yield optimization)         │
│       └── Lulo Lending (idle capital yield)             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```
