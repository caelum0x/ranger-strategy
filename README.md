# Ranger Delta-Neutral Vault

AI-powered USDC delta-neutral funding harvester on Solana.

**Ranger Build-A-Bear Hackathon** (Mar 9 – Apr 6, 2026)

---

## Overview

Ranger Delta-Neutral Vault accepts USDC deposits into a Ranger Earn vault and deploys capital into a fully on-chain, AI-managed delta-neutral strategy on Drift. It simultaneously holds spot assets (or LSTs) and short perpetual positions to harvest funding payments in both directions — targeting **17–27% APY** with tightly controlled risk.

**Drift Side Track eligible** — Drift is the primary execution venue for all spot and perp legs.

### Yield Stack

| Source | Expected APY |
|--------|-------------|
| Drift perp funding (bi-directional) | 8–15% |
| Drift spot lending yield | 2–5% |
| JitoSOL/mSOL staking yield (LST stacking) | ~7% |
| AI alpha (timing + rotation + momentum) | 2–5% |
| **Total** | **17–27%** |

## Architecture

```
                       USDC Deposit
                            │
                   ┌────────▼────────┐
                   │ Ranger Earn Vault│
                   │  (Voltr / USDC) │
                   └────────┬────────┘
                            │ manager deposits
                            ▼
               ┌────────────────────────┐
               │   Drift Strategy       │
               │  (vault delegate acct) │
               └──────────┬─────────────┘
                           │
            ┌──────────────▼──────────────┐
            │       AI Strategy Agent      │
            │                              │
            │  ┌─────────────────────────┐ │
            │  │  DriftFundingAnalyzer   │ │
            │  │  (mark-oracle premium,  │ │
            │  │   imbalance, momentum)  │ │
            │  └──────────┬──────────────┘ │
            │             │                │
            │  ┌──────────▼──────────────┐ │
            │  │  LLM Strategy Advisor   │ │
            │  │  (Claude — regime,      │ │
            │  │   predictions, sizing)  │ │
            │  └──────────┬──────────────┘ │
            │             │                │
            │  ┌──────────▼──────────────┐ │
            │  │  StrategyEngine         │ │
            │  │  - Bi-directional entry │ │
            │  │  - LST yield stacking   │ │
            │  │  - Asset rotation       │ │
            │  └──────────┬──────────────┘ │
            │             │                │
            │  ┌──────────▼──────────────┐ │
            │  │  RiskManager            │ │
            │  │  - Health ≥ 1.10        │ │
            │  │  - Drawdown ≤ 3%        │ │
            │  │  - Leverage ≤ 2x        │ │
            │  │  - Delta ±5%            │ │
            │  └──────────┬──────────────┘ │
            │             │                │
            │  ┌──────────▼──────────────┐ │
            │  │  DriftExecutor          │ │
            │  │  - Atomic cancel+entry  │ │
            │  │  - LST swap + short     │ │
            │  │  - Versioned txs + LUT  │ │
            │  └─────────────────────────┘ │
            └──────────────────────────────┘
```

**Key components:**

- **RangerVaultManager** — Ranger Earn (Voltr) vault lifecycle: create, strategy init, deposit/withdraw capital, fee harvest, withdrawal liquidity monitoring.
- **StrategyEngine** — bi-directional signal generation, LST yield stacking, Kelly-inspired position sizing, dynamic asset rotation.
- **DriftFundingAnalyzer** — on-chain PerpMarketAccount parsing: mark-oracle premium, long/short imbalance, momentum scoring.
- **LLM Strategy Advisor** — Claude-powered regime classification, funding predictions, trade decisions with audit trail reasoning.
- **RiskManager** — real-time health ratio, drawdown, leverage, delta-neutrality, and oracle staleness checks.
- **DriftExecutor** — atomic cancel-and-enter transactions, LST swap + short in single tx, versioned transactions with address lookup tables.
- **TelegramAlerter** — real-time cycle summaries, emergency alerts, health warnings.

## LST Yield Stacking

For SOL short-perp entries, instead of holding raw SOL as spot collateral the strategy swaps USDC → JitoSOL (or best available LST) atomically. This adds ~7% staking APY on top of the funding harvest with **no additional risk**:

```
Standard:  short SOL-PERP + long SOL spot    → funding + lending
LST Stack: short SOL-PERP + long JitoSOL     → funding + lending + staking (~7%)
```

The LST earns staking yield while serving as collateral for the perp short, and the perp short hedges the SOL price exposure — maintaining delta neutrality.

## Risk Management

| Control | Setting |
|---------|---------|
| Health ratio floor | 1.10 (emergency unwind at 1.05) |
| Max drawdown | 3% (circuit breaker) |
| Max leverage | 2x |
| Delta neutrality band | ±5% |
| Oracle staleness guard | 60s staleness threshold |
| Withdrawal liquidity | Auto-pulls from Drift when idle < pending redemptions |
| Min funding APY | 10% (skip trade if expected yield below threshold) |

## Hackathon Eligibility

| Requirement | Status |
|-------------|--------|
| Min APY 10% | ✅ Target 17–27% (funding + lending + staking) |
| Base asset USDC | ✅ USDC only |
| No ponzi stables | ✅ Pure funding arbitrage |
| No junior tranches | ✅ No insurance pool exposure |
| No DEX LP (JLP/HLP) | ✅ Spot + perp only, no AMM LP |
| Health rate > 1.05 | ✅ Floor 1.10, emergency at 1.05 |

## Quick Start

```bash
npm install

# 1. Configure environment
cp .env.mainnet .env
# Fill: HELIUS_RPC_URL, ANCHOR_WALLET, OPENROUTER_API_KEY

# 2. Preflight check
npx ts-node scripts/mainnet-launch.ts

# 3. One-time vault setup
npx ts-node scripts/init-vault.ts          # → add VAULT_PUBKEY to .env
npx ts-node scripts/init-strategy.ts       # → add STRATEGY_PUBKEY to .env
npx ts-node scripts/deposit-ranger-strategy.ts --amount 20

# 4. Start agent
npm run agent
# Monitor: http://localhost:3000/status
```

## Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run agent` | Start the live AI strategy agent |
| `npx ts-node scripts/mainnet-launch.ts` | Preflight checklist before going live |
| `npx ts-node scripts/init-vault.ts` | Create Ranger Earn vault (one-time) |
| `npx ts-node scripts/init-strategy.ts` | Initialize Drift strategy on vault (one-time) |
| `npx ts-node scripts/deposit-ranger-strategy.ts` | Move idle USDC to Drift strategy |
| `npx ts-node scripts/withdraw-ranger-strategy.ts` | Pull USDC back to vault idle |
| `npx ts-node scripts/vault-status.ts` | Current vault TVL, share price, fees |
| `npx ts-node scripts/drift-status.ts` | Drift positions and health |
| `npx ts-node scripts/simulate.ts` | Simulate strategy on historical data |
| `npx ts-node scripts/export-trades.ts` | Export trade history CSV for submission |

## Strategy Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_FUNDING_APY` | `0.10` | Minimum annualized funding rate to open a position |
| `MAX_LEVERAGE` | `2.0` | Maximum portfolio leverage |
| `HEALTH_RATIO_FLOOR` | `1.10` | Minimum health ratio (emergency unwind at 1.05) |
| `MAX_DRAWDOWN_PCT` | `3.0` | Circuit-breaker drawdown threshold (%) |
| `REBALANCE_INTERVAL_MS` | `28800000` | Rebalance interval — 8h, aligned with Drift funding |
| `TARGET_ASSETS` | `SOL,BTC,ETH` | Assets to trade |
| `STRATEGY_MODE` | `drift-only` | `drift-only` (on-chain) or `cross-venue` (+ Binance) |

## Project Structure

```
src/
  agent/      — AI strategy agent main loop, cron scheduler, monitor server
  ai/         — LLM strategy advisor (OpenRouter/Claude), funding predictor
  alerts/     — Telegram alerter
  binance/    — Binance perp integration (cross-venue mode)
  config/     — Environment configuration
  drift/      — Drift SDK: manager, executor, vault, funding analyzer, data API
  ranger/     — Ranger Earn (Voltr) vault management
  risk/       — Risk manager, oracle guard
  strategy/   — Strategy engine, EMA predictor, LST helpers, types
  utils/      — Logger, state store, yield analytics, trade logger, solana helpers
  vault/      — Vault performance tracker
  monitor/    — HTTP monitoring server

scripts/
  init-vault.ts                — Create Ranger Earn vault
  init-strategy.ts             — Initialize Drift strategy
  deposit-ranger-strategy.ts   — Fund strategy with vault USDC
  withdraw-ranger-strategy.ts  — Return USDC from strategy to vault
  vault-status.ts              — Vault monitoring
  drift-status.ts              — Drift positions
  mainnet-launch.ts            — Pre-launch preflight
  simulate.ts                  — Historical simulation
  export-trades.ts             — CSV trade export for submission
```

## Tech Stack

- **Drift SDK** (`@drift-labs/sdk`, `@drift-labs/vaults-sdk`) — DEX integration and vault delegation
- **Voltr SDK** (`@voltr/vault-sdk`) — Ranger Earn vault deposits, withdrawals, fee management
- **Solana web3.js** / **SPL Token** — RPC and token operations
- **Anchor** (`@coral-xyz/anchor`) — CPI / PDA derivation
- **Claude / OpenRouter** — LLM strategy reasoning
- **Winston** — structured logging

---

Built for the **Ranger Build-A-Bear Hackathon** (Main Track + Drift Side Track).
