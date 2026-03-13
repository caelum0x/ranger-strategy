# Ranger Delta-Neutral Vault

AI-powered USDC delta-neutral funding harvester on Solana.

**Ranger Build-A-Bear Hackathon** (Mar 9 -- Apr 6, 2026)

---

## Overview

Ranger Delta-Neutral Vault deposits USDC into a Ranger Earn vault, buys spot assets on Drift, and opens matching short perpetual positions on Binance to collect funding-rate payments while remaining market-neutral. An AI agent continuously analyzes on-chain funding data, detects market regimes, and rotates capital toward the highest-yielding pairs -- targeting 12-25% APY with tightly controlled risk.

## Architecture

```
                       USDC Deposit
                            |
                   +--------v--------+
                   | Ranger Earn Vault|
                   | (Voltr / USDC)   |
                   +--------+--------+
                            |
              +-------------v--------------+
              |     AI Strategy Agent      |
              |  DriftFundingAnalyzer       |
              |  StrategyEngine            |
              |  RiskManager               |
              +------+-------------+-------+
                     |             |
           +---------v---+  +-----v-----------+
           | Drift       |  | Binance         |
           | (Spot Long) |  | (Perp Short)    |
           | DriftManager|  | BinanceManager  |
           | DriftExecutor| |                 |
           +-------------+  +-----------------+
                     |             |
                     +------+------+
                            |
                     Funding Income
```

**Key components:**

- **StrategyEngine** -- orchestrates asset selection, position sizing, and rebalance timing.
- **RiskManager** -- enforces health-ratio floors, drawdown limits, leverage caps, and delta-neutrality bounds.
- **DriftManager / DriftExecutor** -- manages Drift subaccount state, order placement, and atomic transaction execution.
- **DriftVaultManager** -- handles Drift vault delegate trading on behalf of depositors.
- **DriftFundingAnalyzer** -- pulls historical and predicted funding rates to rank assets.
- **BinanceManager** -- manages perpetual short positions and funding collection on Binance via CCXT.

## Key Features

- **On-chain funding analysis** -- 7-day lookback with 24-48h forward prediction to rank assets by expected funding yield.
- **Atomic transaction execution** -- Drift orders are built and sent as single Solana transactions to avoid partial fills.
- **Vault delegate trading** -- operates as a delegate on a Drift vault so user funds stay non-custodial.
- **Risk management** -- real-time monitoring of health ratio (floor 1.10), max drawdown (3%), leverage cap (2x), and delta neutrality (within +/-5%).
- **Market regime detection** -- classifies conditions as bull, bear, neutral, or volatile and adjusts sizing accordingly.
- **Cross-venue execution** -- spot on Drift + perps on Binance for deeper liquidity and funding-rate divergence alpha.
- **Backtesting framework** -- replay historical funding data to validate strategy parameters before going live.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Fill in: ANCHOR_WALLET, VAULT_PUBKEY, BINANCE_API_KEY, BINANCE_SECRET

# Build
npm run build

# Run backtest against historical data
npm run backtest

# Start the live AI agent
npm run agent
```

## Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `tsc` | Compile TypeScript to JavaScript |
| `dev` | `ts-node src/index.ts` | Run the main entry point in development mode |
| `agent` | `ts-node src/agent/index.ts` | Start the live AI strategy agent |
| `backtest` | `ts-node src/backtest/run.ts` | Run backtesting against historical funding data |
| `vault:init` | `ts-node scripts/init-vault.ts` | Initialize the Ranger Earn (Voltr) vault |
| `vault:deposit` | `ts-node scripts/deposit-strategy.ts` | Deposit USDC into the strategy vault |
| `vault:withdraw` | `ts-node scripts/withdraw-strategy.ts` | Withdraw USDC from the strategy vault |
| `vault:status` | `ts-node scripts/vault-status.ts` | Display current vault status and balances |
| `drift:status` | `ts-node scripts/drift-status.ts` | Display Drift subaccount positions and health |
| `drift:init-vault` | `ts-node scripts/init-drift-vault.ts` | Initialize the Drift vault for delegate trading |
| `export-trades` | `ts-node scripts/export-trades.ts` | Export trade history to file |
| `lint` | `eslint src/` | Lint source code |
| `test` | `jest` | Run test suite |

## Strategy Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_LEVERAGE` | `2.0` | Maximum portfolio leverage |
| `HEALTH_RATIO_FLOOR` | `1.10` | Minimum acceptable health ratio (emergency at 1.05) |
| `MAX_DRAWDOWN_PCT` | `3.0` | Circuit-breaker drawdown threshold (%) |
| `REBALANCE_INTERVAL_MS` | `28800000` | Rebalance interval -- 8 hours, aligned with funding |
| `TARGET_ASSETS` | `SOL,BTC,ETH` | Comma-separated list of assets to trade |
| `FUNDING_PREDICTION_LOOKBACK_HOURS` | `168` | Hours of funding history for prediction (7 days) |
| `REGIME_DETECTION_WINDOW` | `48` | Hours of price data for regime classification |

## Project Structure

```
src/
  agent/       -- Live AI strategy agent loop and scheduling
  backtest/    -- Historical backtesting framework
  binance/     -- Binance perpetual futures integration via CCXT
  config/      -- Environment and program configuration
  drift/       -- Drift SDK wrappers: manager, executor, vault, funding analyzer
  ranger/      -- Ranger Earn (Voltr) vault integration
  risk/        -- Risk manager: health ratio, drawdown, delta, leverage checks
  strategy/    -- Strategy engine: asset ranking, position sizing, rebalance logic
  utils/       -- Shared utilities, logging (Winston), helpers
```

## Tech Stack

- **Drift SDK** (`@drift-labs/sdk`, `@drift-labs/vaults-sdk`) -- Drift DEX interaction and vault delegation
- **Solana web3.js** (`@solana/web3.js`, `@solana/spl-token`) -- Solana RPC and token operations
- **Anchor** (`@coral-xyz/anchor`) -- Solana program framework for CPI calls
- **CCXT** (`ccxt`) -- Binance perpetual futures trading
- **Voltr SDK** (`@voltr/vault-sdk`) -- Ranger Earn vault deposits and withdrawals
- **TypeScript** -- end-to-end type safety with `ts-node` for development

---

Built for the Ranger Build-A-Bear Hackathon.
