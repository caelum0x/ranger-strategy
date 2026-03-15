# Strategy: AI-Powered USDC Delta-Neutral Funding Harvester

## Thesis

Perpetual futures markets structurally overpay one side via funding rates. Retail and leveraged traders create persistent directional imbalances, driving funding rates away from zero. This strategy systematically harvests funding payments in **both directions** while maintaining delta-neutral exposure, using AI to optimize asset selection, timing, and risk management.

## How It Works

### Core Mechanism
1. **Accept USDC deposits** into a Ranger Earn vault (on-chain, non-custodial)
2. **Open delta-neutral basis pairs** on Drift — spot + perp legs
3. **Bi-directional funding collection**:
   - When funding is positive (longs pay shorts): long spot + short perp
   - When funding is negative (shorts pay longs): short spot + long perp
4. **AI agent** continuously monitors funding direction, momentum, and regime to optimize positions

### Operating Modes

**Drift-Only (default)** — All capital stays on-chain. Both spot and perp legs on Drift. Fully compatible with vault seeding — seeded capital stays in the Drift vault.

**Cross-Venue (optional)** — Spot on Drift + perp on Binance. Deeper perp liquidity and funding rate divergence, but requires off-chain CEX capital.

### Position Structure (Drift-Only Mode)
```
USDC Deposit ($20) → Drift Vault (delegate trading)
├── SOL basis pair ($6.67)
│   ├── Long SOL spot on Drift
│   └── Short SOL-PERP on Drift
├── BTC basis pair ($6.67)
│   ├── Long BTC spot on Drift
│   └── Short BTC-PERP on Drift
└── ETH basis pair ($6.67)
    ├── Long ETH spot on Drift
    └── Short ETH-PERP on Drift

When funding flips negative → reverse all legs:
    ├── Short SOL spot on Drift (borrow-sell)
    └── Long SOL-PERP on Drift
```

### Why Drift-Only Is Default
- All capital stays on-chain — compatible with vault seeding (up to $500K)
- No counterparty risk from CEX custody
- Both settlement legs on same platform — no timing mismatch
- Drift spot earns lending APY while serving as collateral
- Vault delegate model enables non-custodial fund management

## Yield Sources

| Source | Expected APY |
|--------|-------------|
| Drift perp funding (bi-directional) | 8–15% |
| Drift spot lending yield | 2–5% |
| JitoSOL/mSOL staking yield (LST stacking) | ~7% |
| AI alpha (timing + rotation + momentum) | 2–5% |
| **Total** | **17–27%** |

## LST Yield Stacking

For SOL-directional entries where the perp side is short (funding positive), the strategy swaps USDC → JitoSOL (or best available LST) as spot collateral atomically via `DriftExecutor.atomicLSTEntry`. This adds ~7% staking APY with no additional risk:

```
Standard approach:
  Long SOL spot  +  Short SOL-PERP  →  perp funding + Drift lending yield

LST stack approach:
  Long JitoSOL  +  Short SOL-PERP  →  perp funding + Drift lending yield + JitoSOL staking (~7%)
```

JitoSOL holds full SOL price exposure (delta-neutral hedge remains intact) while simultaneously earning MEV-boosted liquid staking rewards (~7.5% APY). The perp short offsets the SOL price risk — the strategy receives staking yield essentially for free.

## AI Agent Capabilities

### 1. Bi-Directional Funding Analysis
- Analyzes funding rates in both directions (positive AND negative)
- Determines optimal perp side: short when funding positive, long when negative
- Calculates absolute yield to maximize returns regardless of market direction
- Funding rate momentum scoring (current rate vs 24h average EMA)

### 2. On-Chain Funding Prediction
- Reads live PerpMarketAccount AMM data from Drift
- Computes mark-oracle premium, long/short imbalance, and trend
- Predicts next 24-48h funding direction with confidence scoring
- Historical rate trend analysis via linear regression

### 3. Regime Detection
- Classifies market as: bull, bear, neutral, volatile
- Adjusts leverage and position sizing per regime
- Bull → higher allocation (funding rates tend positive, short perp)
- Bear → reverse positions (funding rates tend negative, long perp)
- Volatile → tighten risk limits, reduce sizing

### 4. Dynamic Asset Rotation
- Ranks assets by absolute risk-adjusted funding yield
- Rotates capital toward highest-yielding pairs
- Considers momentum: rising funding in our direction gets a bonus
- Exits assets where absolute funding falls below 5% APY threshold

### 5. Risk Management
- Real-time health ratio monitoring (floor: 1.10, emergency: 1.05)
- Auto-deleverage if health ratio approaches floor
- Circuit breaker on 3% drawdown — unwind all positions
- Delta rebalancing every 8h (aligned with funding settlement)
- Vault withdrawal risk monitoring — detects liquidation takeover risk

## Risk Management Framework

### Position Limits
- Max leverage: 2x
- Max per-asset allocation: 33% of total capital (3 assets)
- Min position size: $5
- Health ratio floor: 1.10 (above 1.05 disqualification threshold)
- Min funding APY to trade: 5% (configurable)

### Drawdown Controls
- Max drawdown: 3% of initial capital
- Circuit breaker: 3% drawdown → close all positions to USDC
- Emergency unwind uses atomic transactions (cancel + close in single tx)

### Delta Neutrality
- Net delta must stay within +/-5% of zero
- Each basis pair is inherently delta-neutral (equal spot + perp)
- Rebalance frequency: every 8 hours minimum

### Funding Rate Risk
- **Bi-directional strategy eliminates zero-funding dead zones**: When funding flips sign, the agent reverses legs instead of exiting
- Diversify across 3 assets to reduce single-asset risk
- Monitor aggregate long/short ratios as leading indicator
- Exit only when absolute funding falls below 5% APY threshold

## Technical Architecture

```
┌─────────────────────────────────────────────┐
│              RANGER EARN VAULT              │
│         (USDC deposits / LP tokens)         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│         DRIFT VAULT (Delegate)              │
│    Agent trades on vault's Drift account    │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              AI STRATEGY AGENT              │
│                                             │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │ Funding     │  │ Regime Detection     │  │
│  │ Analyzer    │  │ (bull/bear/neutral)  │  │
│  │ (bi-dir +   │  └──────────┬───────────┘  │
│  │  momentum)  │             │              │
│  └──────┬──────┘             │              │
│         │                    │              │
│  ┌──────▼────────────────────▼───────────┐  │
│  │        Decision Engine                │  │
│  │  - Bi-directional signal generation   │  │
│  │  - Asset ranking & rotation           │  │
│  │  - Position sizing (Kelly-inspired)   │  │
│  └──────┬───────────────────┬────────────┘  │
│         │                   │               │
│  ┌──────▼──────┐   ┌───────▼────────┐      │
│  │ Risk Manager│   │ Trade Executor │      │
│  │ - Health    │   │ - Drift SDK    │      │
│  │ - Drawdown  │   │ - Atomic txs   │      │
│  │ - Delta     │   │ - Settlement   │      │
│  └─────────────┘   └────────────────┘      │
└─────────────────────────────────────────────┘
```

## Wallet Infrastructure

The strategy supports multiple key management backends via the wallet provider abstraction:

| Backend | Use Case |
|---------|----------|
| Keypair file (ANCHOR_WALLET) | Development and hackathon |
| Base58 key (SOLANA_PRIVATE_KEY) | Quick testing |
| Cobo MPC (COBO_API_KEY) | Production deployment |

Cobo MPC wallet infrastructure (hackathon sponsor) enables institutional-grade key management without changing strategy code.

## Eligibility Compliance

| Requirement | Status |
|-------------|--------|
| Minimum APY: 10% | Target 17-27% (funding + lending + LST staking) |
| 3-month lock, rolling | Configurable redeem period on Drift vault |
| No ponzi stables | USDC only, no circular dependencies |
| No junior tranches | No insurance pool designs |
| No DEX LP vaults | No JLP/HLP/LLP exposure |
| Health rate > 1.05 | Floor set at 1.10 with emergency unwind at 1.05 |

## Scalability with Seeded TVL

If awarded vault seeding (up to $500K):
- **Drift-only mode**: All capital stays on-chain in the Drift vault. The agent trades as vault delegate — no custody transfer needed.
- Drift perp markets (SOL, BTC, ETH) support $10M+ daily volume — $500K positions are well within liquidity.
- The vault's redeem period protects against bank-run scenarios.
- Vault withdrawal risk monitoring detects and prevents liquidation takeovers.
