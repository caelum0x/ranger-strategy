# Ranger Delta-Neutral Vault

AI-powered USDC delta-neutral funding harvester on Solana.

**Ranger Build-A-Bear Hackathon** (Mar 9 - Apr 6, 2026)

---

## Overview

Ranger Delta-Neutral Vault accepts USDC deposits into a Ranger Earn vault and deploys capital into a Drift-first, AI-managed delta-neutral strategy. It supports fully on-chain execution, LST yield stacking, and a new self-indexing webhook service that refreshes Voltr vault state after Helius events and stores local snapshots for the bot.

**Drift Side Track eligible**: Drift is the primary execution venue for spot and perp legs in `drift-only` mode.

### Yield Stack

| Source | Expected APY |
|--------|-------------|
| Drift perp funding | 8-15% |
| Drift spot lending yield | 2-5% |
| JitoSOL/mSOL staking yield | ~7% |
| AI timing and rotation | 2-5% |
| **Total target** | **17-27%** |

## Architecture

```text
                     Helius Webhook
                            |
                   +--------v--------+
                   | Indexer Service |
                   | Voltr parser    |
                   | JSON state DB   |
                   | AI decision log |
                   +--------+--------+
                            |
                   +--------v--------+
                   | Ranger Earn Vault|
                   | (Voltr / USDC)   |
                   +--------+--------+
                            |
              +-------------v--------------+
              |     AI Strategy Agent      |
              |  DriftFundingAnalyzer      |
              |  LLM Strategy Advisor      |
              |  StrategyEngine            |
              |  RiskManager               |
              +-------------+--------------+
                            |
                       +----v----+
                       | Drift   |
                       | spot +  |
                       | perps   |
                       +---------+
```

## Key Components

- **RangerVaultManager**: Ranger Earn vault lifecycle, deposits, withdrawals, and fee tracking.
- **DriftFundingAnalyzer**: funding, premium, and market-structure analysis for asset selection.
- **LLM Strategy Advisor**: regime classification and trade reasoning through OpenRouter.
- **StrategyEngine**: bi-directional funding capture, LST stacking, and rotation logic.
- **RiskManager**: health ratio, drawdown, leverage, and delta-neutrality controls.
- **Indexer Service**: Helius-triggered vault refreshes persisted to `.ranger-state/indexer-state.json`.

## Key Features

- **Bi-directional delta-neutral execution**: can collect positive or negative funding depending on market regime.
- **LST yield stacking**: replace raw SOL spot exposure with JitoSOL/mSOL where appropriate.
- **Self-indexing vault telemetry**: refresh vault state locally without depending on partner-side indexing.
- **Drift-first deployment path**: supports a fully on-chain setup for seedable Ranger vault capital.
- **Backtesting and monitoring**: existing strategy scripts remain available for simulation and ops.

## Quick Start

```bash
npm install

# Configure environment
cp .env.mainnet .env
# Fill in wallet, vault, RPC, and API keys

# Build
npm run build

# Start the live agent
npm run agent

# Start the self-indexing webhook server
npm run indexer
```

## Self-Indexing Flow

Set these variables in `.env`:

```bash
HELIUS_API_KEY=...
WEBHOOK_URL=https://your-public-url/webhook
VAULT_PUBKEY=...
PORT=3000
```

Then:

```bash
npm run indexer
npm run indexer:webhook:create
```

The indexer listens on `POST /webhook`, exposes `GET /health`, and writes snapshots plus rebalance recommendations to `.ranger-state/indexer-state.json`.

## Real Devnet Workflow

The executable initialize/deposit/withdraw path in this repo is the real Drift vault flow, not the custom adaptor scaffold.

Use `.env.devnet`, then run:

```bash
npm run devnet:vault-workflow
```

What it does:

- initializes a real Drift vault on devnet if you do not pass `--vault`
- ensures the wallet has a Drift user account and enough devnet USDC collateral
- manager-deposits into the vault
- submits a manager withdrawal request
- completes the withdrawal immediately when `--redeem-period 0` is used

Examples:

```bash
npm run devnet:vault-workflow
npm run devnet:vault-workflow -- --deposit 15 --withdraw 5
npm run devnet:vault-workflow -- --vault <PUBKEY> --skip-init --redeem-period 0
```

This is the recommended real test path for end-to-end vault operations. In parallel, the repo now also includes a real Drift-targeted custom adaptor path under `driftbear-adaptor/` and matching client-side remaining-account helpers in `src/ranger/`.

## Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `tsc` | Compile TypeScript to JavaScript |
| `agent` | `ts-node src/agent/index.ts` | Start the live AI strategy agent |
| `backtest` | `ts-node src/backtest/run.ts` | Run backtesting against historical data |
| `vault:init` | `ts-node scripts/init-vault.ts` | Initialize the Ranger Earn vault |
| `vault:deposit` | `ts-node scripts/deposit-strategy.ts` | Deposit USDC into the strategy vault |
| `vault:withdraw` | `ts-node scripts/withdraw-strategy.ts` | Withdraw USDC from the strategy vault |
| `vault:status` | `ts-node scripts/vault-status.ts` | Display current vault status and balances |
| `drift:status` | `ts-node scripts/drift-status.ts` | Display Drift positions and health |
| `drift:init-vault` | `ts-node scripts/init-drift-vault.ts` | Initialize the Drift vault for delegate trading |
| `liquidator` | `ts-node scripts/liquidator.ts` | Run the standalone Drift liquidation bot |
| `indexer` | `ts-node src/indexer/server.ts` | Start the Helius webhook listener and local indexer |
| `indexer:webhook:create` | `ts-node scripts/create-helius-webhook.ts` | Register a Helius webhook for the configured vault |
| `indexer:backfill` | `ts-node scripts/indexer-backfill.ts` | Manually index the configured vault immediately |
| `export-trades` | `ts-node scripts/export-trades.ts` | Export trade history for submission |

## Strategy Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_FUNDING_APY` | `0.05` | Minimum annualized funding rate to open a position |
| `MAX_LEVERAGE` | `2.0` | Maximum portfolio leverage |
| `HEALTH_RATIO_FLOOR` | `1.10` | Minimum health ratio |
| `MAX_DRAWDOWN_PCT` | `3.0` | Circuit-breaker drawdown threshold (%) |
| `REBALANCE_INTERVAL_MS` | `28800000` | Rebalance interval in ms |
| `JUPITER_SWAP_SLIPPAGE_BPS` | `100` | Max slippage for Jupiter derisk swaps in bps |
| `TARGET_ASSETS` | `SOL,BTC,ETH` | Assets to trade |
| `STRATEGY_MODE` | `drift-only` | `drift-only` or `cross-venue` |

## Liquidator

This repo now includes a separate liquidation runner for Drift. It is intentionally isolated from the vault agent.

```bash
npm run liquidator -- --once
```

Recommended env for first run:

```bash
LIQUIDATION_DRY_RUN=true
LIQUIDATION_SCAN_INTERVAL_MS=5000
LIQUIDATION_MAX_USERS_PER_TICK=5
LIQUIDATION_TAKEOVER_PCT=0.25
LIQUIDATION_AUTO_DERISK=true
LIQUIDATION_SUBACCOUNTS=0,1
LIQUIDATION_DEFAULT_SUBACCOUNT_ID=0
LIQUIDATION_PERP_SUBACCOUNT_MAP=0:0,1:1,2:1
LIQUIDATION_SPOT_SUBACCOUNT_MAP=1:0,2:1,3:1
LIQUIDATION_PRIORITY_FEE_MULTIPLIER=1.2
LIQUIDATION_MAX_PRIORITY_FEE_MICROLAMPORTS=250000
LIQUIDATION_FALLBACK_PRIORITY_FEE_MICROLAMPORTS=50000
```

Current scope:

- scans `UserMap` for liquidatable or already-being-liquidated users
- prioritizes candidates by liquidation distance
- supports market-to-subaccount routing for perp and spot takeovers
- attempts basic `liquidatePerp` and `liquidateSpot`
- attempts `liquidatePerpPnlForDeposit` when a user has positive perp PnL
- resolves simple bankruptcy cases
- throttles repeated failures for a short backoff window
- applies Helius-backed dynamic priority fees to liquidation transactions
- derisks inherited exposures with a fuller subaccount sequence: cancel orders, close perps, settle pnl, unwind borrows, swap residual spot inventory to USDC

It still does not implement the full `keeper-bots-v2` strategy surface such as maker fill paths and the deeper DLOB-driven derisk flow.

## Project Structure

```text
src/
  agent/       live strategy loop and scheduling
  ai/          OpenRouter integration and reasoning
  backtest/    historical simulation
  binance/     cross-venue Binance integration
  config/      environment and runtime configuration
  drift/       Drift SDK wrappers and execution
  indexer/     webhook listener, parser, store, decision engine
  ranger/      Ranger Earn / Voltr integration
  risk/        health and drawdown controls
  strategy/    portfolio construction and rebalance logic
  utils/       logging and shared helpers
```

## Tech Stack

- **Drift SDK** (`@drift-labs/sdk`, `@drift-labs/vaults-sdk`)
- **Voltr SDK** (`@voltr/vault-sdk`)
- **Solana web3.js** / **SPL Token**
- **Anchor** (`@coral-xyz/anchor`)
- **OpenRouter**
- **TypeScript**

---

Built for the Ranger Build-A-Bear Hackathon.
