# Strategy: AI-Powered USDC Delta-Neutral Funding Harvester

## Thesis

Perpetual futures markets structurally overpay short holders via funding rates. Retail and leveraged traders are persistently net-long, creating a positive funding rate bias. This strategy systematically harvests this premium while maintaining delta-neutral exposure, using AI to optimize asset selection, timing, and risk management.

## How It Works

### Core Mechanism
1. **Accept USDC deposits** into a Ranger Earn vault
2. **Buy spot assets** (SOL, BTC, ETH) on Drift — the "long leg"
3. **Short equivalent perps** on Binance (or Drift) — the "short leg"
4. **Collect funding payments** every 8 hours from short positions
5. **AI agent** continuously monitors and optimizes the portfolio

### Position Structure
```
USDC Deposit ($20)
├── SOL basis pair ($6.67)
│   ├── Long SOL spot on Drift
│   └── Short SOL-PERP on Binance
├── BTC basis pair ($6.67)
│   ├── Long BTC spot on Drift
│   └── Short BTC-PERP on Binance
└── ETH basis pair ($6.67)
    ├── Long ETH spot on Drift
    └── Short ETH-PERP on Binance
```

### Why Cross-Venue (Drift + Binance)?
- Binance has deeper perp liquidity → tighter spreads, more consistent positive funding
- Drift spot earns lending APY while serving as collateral → additional yield layer
- Funding rate divergence between venues creates extra alpha

## Yield Sources

| Source | Expected APY |
|--------|-------------|
| Binance perp funding (short) | 8-15% |
| Drift spot lending yield | 2-5% |
| AI alpha (timing + rotation) | 2-5% |
| **Total** | **12-25%** |

## AI Agent Capabilities

### 1. Funding Rate Prediction
- Analyzes 7-day lookback of funding rates across all assets
- Predicts next 24-48h funding direction using trend analysis
- Ranks assets by predicted funding income

### 2. Regime Detection
- Classifies market as: bull, bear, neutral, volatile
- Adjusts leverage and position sizing per regime
- Bull → higher allocation (funding rates tend positive)
- Bear → reduce positions (funding can flip negative)
- Volatile → tighten risk limits

### 3. Dynamic Asset Rotation
- Continuously ranks assets by risk-adjusted predicted funding yield
- Rotates capital toward highest-yielding pairs
- Avoids assets with negative or declining funding

### 4. Risk Management
- Real-time health ratio monitoring (floor: 1.10, emergency: 1.05)
- Auto-deleverage if health ratio approaches floor
- Circuit breaker on 3% drawdown — unwind all positions
- Delta rebalancing every 8h (aligned with funding settlement)

## Risk Management Framework

### Position Limits
- Max leverage: 2x
- Max per-asset allocation: 40% of total capital
- Min position size: $5 (Binance minimum)
- Health ratio floor: 1.10 (above 1.05 requirement)

### Drawdown Controls
- Max drawdown: 3% of initial capital
- Warning level: 2% drawdown → reduce all positions by 50%
- Circuit breaker: 3% drawdown → close all positions to USDC

### Delta Neutrality
- Net delta must stay within ±5% of zero
- Rebalance triggered when delta exceeds ±3%
- Rebalance frequency: every 8 hours minimum
- Emergency rebalance: when delta exceeds ±5%

### Funding Rate Risk
- Exit position if predicted funding turns negative for >24h
- Diversify across 3+ assets to reduce single-asset funding reversal risk
- Monitor aggregate long/short ratios as leading indicator

## Technical Architecture

```
┌─────────────────────────────────────────────┐
│              RANGER EARN VAULT              │
│         (USDC deposits / LP tokens)         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              AI STRATEGY AGENT              │
│                                             │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │ Funding     │  │ Regime Detection     │  │
│  │ Predictor   │  │ (bull/bear/neutral)  │  │
│  └──────┬──────┘  └──────────┬───────────┘  │
│         │                    │              │
│  ┌──────▼────────────────────▼───────────┐  │
│  │        Decision Engine                │  │
│  │  - Asset ranking & selection          │  │
│  │  - Position sizing (Kelly-inspired)   │  │
│  │  - Rebalance timing                   │  │
│  └──────┬───────────────────┬────────────┘  │
│         │                   │               │
│  ┌──────▼──────┐   ┌───────▼────────┐      │
│  │ Risk Manager│   │ Trade Executor │      │
│  │ - Health    │   │ - Drift SDK    │      │
│  │ - Drawdown  │   │ - Binance CCXT │      │
│  │ - Delta     │   │ - Atomic ops   │      │
│  └─────────────┘   └────────────────┘      │
└─────────────────────────────────────────────┘
```

## Eligibility Compliance

| Requirement | Status |
|-------------|--------|
| Minimum APY: 10% | ✅ Target 12-25% |
| 3-month lock, rolling | ✅ Configurable redeem period |
| No ponzi stables | ✅ USDC only, no circular dependencies |
| No junior tranches | ✅ No insurance pool designs |
| No DEX LP vaults | ✅ No JLP/HLP/LLP exposure |
| Health rate > 1.05 | ✅ Floor set at 1.10 |
