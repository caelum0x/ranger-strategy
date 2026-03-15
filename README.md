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
| `indexer` | `ts-node src/indexer/server.ts` | Start the Helius webhook listener and local indexer |
| `indexer:webhook:create` | `ts-node scripts/create-helius-webhook.ts` | Register a Helius webhook for the configured vault |
| `export-trades` | `ts-node scripts/export-trades.ts` | Export trade history for submission |

## Strategy Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_FUNDING_APY` | `0.05` | Minimum annualized funding rate to open a position |
| `MAX_LEVERAGE` | `2.0` | Maximum portfolio leverage |
| `HEALTH_RATIO_FLOOR` | `1.10` | Minimum health ratio |
| `MAX_DRAWDOWN_PCT` | `3.0` | Circuit-breaker drawdown threshold (%) |
| `REBALANCE_INTERVAL_MS` | `28800000` | Rebalance interval in ms |
| `TARGET_ASSETS` | `SOL,BTC,ETH` | Assets to trade |
| `STRATEGY_MODE` | `drift-only` | `drift-only` or `cross-venue` |

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
