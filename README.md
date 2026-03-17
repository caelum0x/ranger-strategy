# Ranger Delta-Neutral Vault

Multi-layer yield vault on Solana — delta-neutral funding capture + DLOB market making + JIT auction fills.

**Ranger Build-A-Bear Hackathon** (Mar 9 - Apr 6, 2026)

---

## Strategy: 5-Layer Yield Stack

| Layer | Source | Expected APY |
|-------|--------|-------------|
| Delta-neutral funding capture | Long spot + short perp on Drift | 15-45% |
| DLOB market making | Oracle-offset bid/ask orders (FloatingPerpMaker) | 10-30% |
| JIT auction fills | Slot-based sniper/shotgun fill modes | Variable |
| DLOB order filling | Match makers with takers for filler rewards | Variable |
| LST yield stacking | JitoSOL/mSOL/bSOL as collateral | 6-8% |

### Backtest Results (3 years, real Drift S3 data)

| Scenario | Costs | CAGR | Max Drawdown | Sharpe |
|----------|-------|------|-------------|--------|
| Ideal (70% maker) | 0.088% | +45.76% | 0.32% | 9.58 |
| Realistic (100% taker + slippage) | 0.30% | +44.88% | 0.60% | 9.37 |

## Architecture

```
User deposits USDC --> Ranger Earn Vault (Voltr)
    |
    v
Custom Drift Adaptor (Anchor program, deployed devnet)
    | CPI
    v
Drift Protocol
    |-- 50% USDC spot lending (deposit APY)
    +-- 50% delta-neutral strategy
         |-- Funding rate capture
         |-- FloatingPerpMaker (DLOB market making)
         |-- JIT auction fills (sniper mode)
         +-- DLOB order filling
```

## Quick Start

```bash
npm install

# Run tests (20 suites, 181 tests)
npm test

# Run backtest
npm run backtest:v2-s3              # Ideal assumptions
npm run backtest:v2-s3-realistic    # Worst-case costs

# Devnet test
npm run devnet:setup
npm run devnet:dry-run

# Start strategy agent
npm run agent

# Start Voltr-compatible rebalance bot
npm run rebalance-bot
```

## On-Chain Programs (Rust/Anchor)

| Program | ID | Lines | Status |
|---------|-----|-------|--------|
| `driftbear_custom_adaptor` | `4JW3mvrVGXpZZ3jxjw16o4REHnWuEGkbvLkPBg1RbFbQ` | 1,058 | Deployed on devnet |
| `custom_adaptor_completed` | `G5RgbPTWyYePXebLMsP6sZTQKkKZhwP3Zn1CnSGhPnPi` | ~200 | Workshop 2 solution |
| `ctoken_market_program` | `DPk5Ptke7pfV64sn3RtqQjYGCNYwtA6vmENxXakVfwpJ` | 345 | Deployed on devnet |

See `docs/ON_CHAIN_PROGRAMS.md` for verified transaction signatures.

## Codebase

| Component | Files | Lines |
|-----------|-------|-------|
| TypeScript (strategy + execution) | 152 | 44K |
| Scripts (vault, lending, LP) | 81 | 14K |
| Rust programs (on-chain) | 6 programs | 95K |
| Tests | 20 suites | 181 pass |

### Key Files

**Strategy:**
- `src/strategy/engine.ts` — core strategy engine (2,328 lines)
- `src/strategy/floating-maker.ts` — DLOB market making (450 lines)
- `src/drift/jit-maker.ts` — JIT auction fills (726 lines)
- `src/drift/filler.ts` — DLOB order filling (599 lines)

**Execution:**
- `src/drift/executor.ts` — atomic txs, Jito bundles, tx simulation (1,498 lines)
- `src/agent/index.ts` — orchestration + lifecycle (954 lines)
- `programs/driftbear_custom_adaptor/src/lib.rs` — on-chain CPI to Drift (1,058 lines)

**Intelligence:**
- `src/ranger/data-api.ts` — funding arbs, liquidation signals
- `src/utils/pyth-oracle.ts` — oracle cross-validation
- `src/lending/sanctum.ts` — LST APY optimization
- `src/venues/flash.ts`, `orca.ts`, `meteora.ts` — multi-venue yield scanning

**Risk:**
- `src/strategy/circuit-breaker.ts` — 6-trigger emergency stop
- `src/risk/manager.ts` — health, drawdown, leverage checks

## Integrated Protocols

| Protocol | Integration | File |
|----------|------------|------|
| Drift | Perps, spot, DLOB, JIT, vaults, lending, insurance | `src/drift/` (14 files) |
| Ranger SOR | Cross-venue routing, quotes, positions | `src/ranger/sor-client.ts` |
| Sanctum | LST swap, APY data | `src/lending/sanctum.ts` |
| Pyth | Oracle price cross-validation | `src/utils/pyth-oracle.ts` |
| Helius | Priority fees, DAS API, webhooks | `src/utils/helius-enhanced.ts` |
| Flash Trade | Cross-venue funding comparison | `src/venues/flash.ts` |
| Orca | Whirlpool LP yield scanning | `src/venues/orca.ts` |
| Meteora | DLMM LP yield scanning | `src/venues/meteora.ts` |
| Lulo/Flexlend | Lending yield aggregation | `src/lending/lulo.ts` |
| deBridge | Cross-chain bridging | `src/venues/debridge.ts` |
| Voltr | Vault strategy management | `src/ranger/voltr-client.ts` |

## Configuration

```bash
cp .env.example .env
# Required:
SOLANA_RPC_URL=https://your-helius-rpc.com
ANCHOR_WALLET=/path/to/keypair.json
DRIFT_ENV=mainnet-beta
# Optional:
OPENROUTER_API_KEY=...     # For LLM regime detection
HELIUS_API_KEY=...         # For priority fees + webhooks
RANGER_API_KEY=...         # For SOR + Data API
```

## Tracks

### Ranger Main Track
Delta-neutral vault deployed via Ranger Earn (Voltr) with custom Drift adaptor.

### Drift Side Track
100% Drift-native: oracle-offset orders, DLOB, JIT auctions, cross-margin, spot lending.

---

Built for the Ranger Build-A-Bear Hackathon.
