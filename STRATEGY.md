# DriftBear Neutral Farmer — Strategy Document

## Overview

AI-powered USDC delta-neutral vault on Ranger Earn (Solana). Captures funding rates, maker rebates, oracle arbitrage, and lending yield across multiple venues while maintaining market-neutral exposure.

**Base Asset:** USDC
**Target APY:** 12-27% (conservative), up to 50%+ in high-funding regimes
**Target Assets:** SOL, BTC, ETH (weighted from 3-year backtest)
**Risk Profile:** Market-neutral (delta-hedged at all times)

---

## Architecture

```
User USDC deposits
  └── Ranger Earn Vault (Voltr SDK, on-chain)
       └── Drift Adaptor (CPI)
            └── Drift User Account (delegated trading)
                 └── Strategy Engine (12 modules)
```

Two on-chain vaults work together:
1. **Ranger Earn Vault** — user-facing product on Ranger UI (Voltr program)
2. **Drift Delegated Account** — the actual trading account the strategy operates

The strategy engine runs off-chain as an autonomous agent with delegate authority over the Drift account.

---

## Revenue Streams

### 1. Delta-Neutral Funding Capture (Primary — 10-50% APY)
- Long spot on Drift + short perp on highest-paying venue
- Compares rates across Drift, Binance, Flash Trade
- Only opens if annualized funding > 10% APY
- Rebalances every 8 hours, 48-hour direction flip cooldown
- Captures the funding rate differential while being market-neutral

### 2. DLOB Market Making (2-10% APY)
- **Floating Maker:** bid/ask orders tracking oracle price with inventory-aware spread skewing
- **Grid Orders:** N buy orders below + N sell orders above oracle price
- Earns 0.02% maker rebate per fill on Drift
- Recommended by Drift Workshop for vault strategies

### 3. Oracle Arbitrage (2-10% APY)
- Cross-exchange basis arb using oracle offset orders
- Buys when Drift mark price < oracle, sells when mark > oracle
- Independent Pyth oracle validation with confidence weighting

### 4. JIT Making (1-5% APY)
- Fills taker orders during JIT auction windows
- Sniper mode (precise fills) or shotgun mode (volume)

### 5. Filler Rewards (0-3% APY)
- Matches resting DLOB orders (perp + spot) for protocol filler rewards
- Settles unrealized PnL for capital efficiency

### 6. Lending Yield (2-5% APY)
- Auto-deploys idle USDC to highest-yielding lending protocol
- Compares rates across Drift Spot, Lulo/Flexlend
- Stacks with LST collateral yield (JitoSOL ~7% APY)

### 7. LP Fees (when deployed — 5-20% APY)
- Raydium CLMM concentrated liquidity with IL hedging via short perp
- Orca Whirlpool and Meteora DLMM scanning for opportunities

---

## Risk Management

### Circuit Breaker
| Parameter | Value |
|-----------|-------|
| Max daily loss | 2% |
| Max leverage | 2.0x |
| Health ratio floor | 1.10 |
| Max drawdown | 3% |
| Max direction flips/day | 1 |
| Oracle staleness threshold | 60 seconds |
| Cooldown on trip | 6 hours |

### Oracle Guard
- Confidence-weighted price validation (max 50 bps spread)
- Size floor checks before trade execution
- Skip multiplier for stale/unreliable feeds
- Independent Pyth cross-validation

### Position Sizing
- AI-powered regime detection (OpenRouter LLM) determines market state
- Position size scaled by funding rate attractiveness and confidence
- Per-asset allocation weights from 3-year backtest:
  - SOL: 22%, BTC: 20%, ETH: 13%, JTO: 23%, INJ: 22%

### Delta Neutrality
- Enforced at all times: long spot = short perp (equal notional)
- Real-time health ratio monitoring
- Emergency unwind triggers if delta exceeds threshold

### Capital Ramp (Phased Deployment)
- New vaults ramp from 10% → 25% → 50% → 75% → 100% over 10 days
- Validates fills, slippage, and funding impact at each tier before scaling
- Accelerates to next tier if cumulative PnL > +0.5%
- Resets on circuit breaker trip; can be disabled for experienced operators
- Config: `CAPITAL_RAMP_DAYS`, `CAPITAL_RAMP_DISABLED`

### Slippage Guard (Per-Asset Liquidity Tiers)
| Tier | Assets | Max Slippage | Depth Check |
|------|--------|-------------|-------------|
| 1 | SOL, BTC, ETH | 80 bps | No (deep markets) |
| 2 | JTO, INJ, etc. | 150 bps | Yes — DLOB depth within 50bps of oracle |

- Tier 2 orders blocked if they exceed 15% of available DLOB depth
- Tracks actual execution slippage per asset; alerts on trends
- Unknown assets default to Tier 2 (conservative)
- Config: `TIER1_MAX_SLIPPAGE_BPS`, `TIER2_MAX_SLIPPAGE_BPS`, `TIER2_MAX_DEPTH_FRACTION`

### Venue Health Monitor (Drift Failover)
| Status | Trigger | Action |
|--------|---------|--------|
| HEALTHY | 0 consecutive failures | Normal operation |
| WARNING | 2+ failures | Log + alert, continue trading |
| DEGRADED | 5+ failures | Block new entries, keep existing positions |
| DOWN | 10+ failures | Skip cycle, attempt Binance failover |

- Tracks Drift RPC responsiveness, oracle freshness, tx success rate
- Auto-routes perp leg to Binance when Drift is DEGRADED/DOWN
- Per-asset oracle staleness tracking — stale assets excluded from trading
- Config: `VENUE_RPC_TIMEOUT_MS`, `VENUE_MAX_ORACLE_AGE_SECONDS`

---

## Vault Configuration

### Ranger Earn Vault (Voltr)
| Parameter | Value |
|-----------|-------|
| Max Cap | Uncapped (u64 max) |
| Performance Fee | 20% (manager) |
| Management Fee | 1% annual (manager) |
| Redemption Fee | 0.1% |
| Issuance Fee | 0.1% |
| Withdrawal Wait | 7 days |
| Locked Profit Degradation | 24 hours |
| Asset | USDC |

### Drift Vault
| Parameter | Value |
|-----------|-------|
| Redeem Period | 7 days |
| Management Fee | 2% |
| Profit Share | 20% |
| Margin Trading | Enabled |
| Spot Market | USDC (index 0) |

---

## Deployment Flow

### Step 1: Deploy Ranger Earn Vault
```bash
npm run deploy-vault -- --network mainnet
npm run setup-lp-metadata
npm run add-adaptor -- --adaptor drift
npm run init-strategy
```

### Step 2: Deploy Drift Vault
```bash
npm run drift:init-vault -- --name "DriftBear Neutral Farmer"
```

### Step 3: Fund & Activate
```bash
# Deposit initial USDC
npm run deposit-ranger-strategy -- --amount 100

# Start the strategy agent
npm run agent
```

### Step 4: Verify & Monitor
```bash
npm run vault:status
npm run drift:status
npm run health-guard
```

---

## Module Architecture

```
Strategy Engine (src/strategy/engine.ts)
├── Delta-Neutral Core
│   ├── Funding Analyzer (src/drift/funding.ts)
│   ├── Cross-Venue Executor (Drift/Binance/Flash)
│   └── Position Manager (rebalance every 8h)
├── Passive Makers
│   ├── Floating Maker (src/strategy/floating-maker.ts)
│   ├── Grid Orders (src/strategy/grid-orders.ts)
│   ├── Oracle Arb (src/strategy/oracle-arb.ts)
│   └── JIT Maker (src/drift/jit-maker.ts)
├── Fillers & Settlers
│   ├── Perp Filler (src/drift/filler.ts)
│   ├── Spot Filler (src/drift/spot-filler.ts)
│   └── PnL Settler (src/drift/pnl-settler.ts)
├── Yield Optimization
│   ├── Lending Rate Scanner (Drift/Lulo/Sanctum)
│   ├── LP Scanner (Orca/Meteora/Raydium)
│   └── Insurance Fund Staking
├── $500K Hardening
│   ├── Capital Ramp (src/strategy/capital-ramp.ts)
│   ├── Slippage Guard (src/strategy/slippage-guard.ts)
│   └── Venue Health Monitor (src/strategy/venue-health.ts)
└── AI Layer
    ├── Regime Detection (OpenRouter LLM)
    ├── Position Sizing Advisor
    └── Risk Assessment
```

---

## Tech Stack

- **On-chain:** Solana, Drift Protocol, Voltr (Ranger Earn), Raydium CLMM
- **SDKs:** @drift-labs/sdk, @drift-labs/vaults-sdk, @voltr/vault-sdk
- **AI:** OpenRouter (Claude Sonnet) for regime detection
- **Execution:** Priority fees via Helius, Jito MEV protection
- **Monitoring:** Custom health guard, funding monitor, vault status dashboard

---

## Infrastructure — Running 24/7

The strategy engine runs off-chain and needs a server to operate continuously.

### Requirements
- **Server:** Any VPS with 1 CPU, 1GB RAM (Hetzner €4/mo, DigitalOcean $6/mo, AWS Lightsail $5/mo)
- **Node.js:** v20+
- **Process manager:** pm2 (auto-restart on crash + server reboot)

### Deployment
```bash
# On server
git clone <repo> ranger && cd ranger && npm install
cp .env.example .env   # Fill in wallet key, RPC URL, etc

# Start with pm2
npm install -g pm2
pm2 start "npm run agent" --name ranger-agent
pm2 save && pm2 startup   # Persist across reboots
```

### Monitoring
```bash
pm2 logs ranger-agent   # Live logs
pm2 monit               # Resource usage
npm run vault:status     # On-chain vault state
npm run health-guard     # Health ratio monitoring
```

### Security
- Dedicated wallet with only strategy funds (not your main wallet)
- SSH key-only authentication
- Firewall: SSH (22) only

---

## Hackathon Tracks

- **Main Track (Ranger Build-A-Bear):** Up to $500K TVL seeding
- **Drift Side Track:** Up to $100K TVL seeding
- **Deadline:** April 6, 2026 23:59 UTC

## Submission Requirements
- Demo video (3 min)
- Strategy document (this file)
- Code repository
- On-chain vault address (mainnet)
- Trade verification (Solscan activity)
