# Ranger Build-A-Bear Hackathon Plan

**Deadline:** April 6, 2026
**Today:** March 17, 2026
**Days remaining:** 20

---

## The Honest Assessment

We have a LOT of code (150K+ lines) but need to be clear about what's real vs reference:

| Category | Files | Lines | Status |
|---|---|---|---|
| Strategy engine + modules | 152 TS files | 44K | Working, tested (181/181 pass) |
| Scripts (vault, lending, LP) | 81 TS files | 14K | Ready to run |
| Rust programs (on-chain) | 6 programs | 95K | 1 deployed on devnet, rest = reference |
| Plugin reference code | 975 files | ~40K | Copied, not all ported |
| **Total** | **~1,200 files** | **~150K** | |

### What Actually Works Right Now
- `npm run agent` — starts the full strategy engine with JIT/Filler/FloatingMaker
- `npm run backtest:v2-s3` — 3-year backtest on real Drift S3 data
- `npm run devnet:dry-run` — end-to-end pipeline test on devnet
- `npm run rebalance-bot` — Voltr-compatible rebalance loop
- 20/20 test suites, 181/181 tests pass, zero TS errors

### What's NOT Working
- No mainnet trades (only devnet adaptor txs)
- Realistic backtest not yet run
- Demo video not recorded
- Many plugin integrations are imports + method stubs (real API calls but no live wallet signing)

---

## Our Strategy: Multi-Layer Yield Vault

We don't have ONE strategy — we have 5 layers that stack:

### Layer 1: Delta-Neutral Funding Capture (Core)
**What:** Long spot + short perp on Drift — collect funding payments
**Yield:** ~15-45% APY (varies with market regime)
**Files:** `engine.ts` (2,328 lines), `executor.ts` (1,498 lines)
**Backtest:** +45.76% CAGR over 3 years on real Drift data

### Layer 2: DLOB Market Making (FloatingPerpMaker)
**What:** Oracle-offset bid/ask orders on Drift DLOB — earn spread + maker rebates (0.02%)
**Yield:** ~10-30% APY (depends on volume)
**Files:** `floating-maker.ts` (450 lines)
**Source:** Ported from keeper-bots-v2/floatingMaker.ts

### Layer 3: JIT Auction Fills
**What:** Fill taker auction orders at optimal slot timing — maker rebates
**Yield:** Variable (depends on order flow)
**Files:** `jit-maker.ts` (726 lines)
**Source:** Ported from jit-proxy/jitterSniper.ts

### Layer 4: DLOB Order Filling
**What:** Match makers with takers on DLOB — earn filler rewards
**Yield:** Variable
**Files:** `filler.ts` (599 lines)
**Source:** Ported from keeper-bots-v2/filler.ts

### Layer 5: LST Yield Stacking
**What:** Use JitoSOL/mSOL/bSOL as collateral instead of raw SOL — earn staking APY
**Yield:** ~6-8% APY on top of funding
**Files:** `lst.ts`, `lending/sanctum.ts`

### Combined Expected Yield
Conservative: 20-30% APY (funding only)
Moderate: 35-50% APY (funding + market making)
Aggressive: 50-70% APY (all layers active)

---

## What We Submit

### Ranger Main Track (up to $500K seeding)

**Vault:** Ranger Earn vault with Drift earn adaptor
**Strategy:** Delta-neutral funding capture + DLOB market making
**Architecture:**
```
User deposits USDC into Ranger Earn Vault (Voltr)
    |
Custom Drift Adaptor (our Anchor program on-chain)
    | CPI
Drift Protocol
    |-- 50% USDC spot lending (earn deposit APY)
    +-- 50% delta-neutral (long spot + short perp)
         |-- Funding rate income
         |-- FloatingPerpMaker spread capture
         +-- JIT auction fills
```

**What judges see:**
1. Vault creation via voltrxyz/base-scripts pattern
2. Drift adaptor init via voltrxyz/drift-scripts pattern
3. Custom rebalance_loop.ts (our delta-neutral strategy)
4. On-chain custom adaptor (driftbear_custom_adaptor deployed on devnet)
5. Strategy documentation with backtest results
6. 3-minute demo video

### Drift Side Track (up to $100K seeding)

**Same strategy** but emphasized as 100% Drift-native:
- Oracle-offset orders (auto-track oracle)
- DLOB market making (FloatingPerpMaker)
- JIT auction participation
- Cross-margin for capital efficiency
- Spot lending for idle yield
- Insurance fund staking

---

## Do We Need Rust?

**Short answer: We already have it.**

The workshop shows the expected pattern:
1. TypeScript rebalance bot (keeper) — we have this
2. On-chain Anchor adaptor (Rust) for CPI to Drift — we have this, deployed on devnet
3. The vault program itself is Voltr's — we don't build this

Our Rust code:
| Program | Lines | Status |
|---|---|---|
| driftbear_custom_adaptor | 1,058 | Deployed on devnet with verified txs |
| custom_adaptor_completed | ~200 | Workshop 2 solution (completed template) |
| ctoken_market_program | 345 | Deployed on devnet |
| drift_vaults | 15,243 | Reference (Drift Labs' program) |
| raydium_clmm | 20,909 | Reference (Raydium's program) |
| drift_rs_sdk | 55,940 | Reference (Drift Rust SDK) |

The judges want to see: our adaptor program + our TypeScript keeper bot.
The reference programs show we understand the full stack.

---

## Backtest Plan

### Already done:
- V2-S3 backtest: 68,072 hourly bars, 3 years, real Drift S3 data
- Result: +45.76% CAGR, 0.32% max DD, Sharpe 9.58

### Realistic backtest (completed):
- 0.30% round-trip costs (3.4x higher than ideal)
- Result: **+44.88% CAGR**, 0.60% max DD, Sharpe 9.37
- Total return: +208.87% ($10K → $30.9K)
- Cost/income: 2.3% (vs 0.9% ideal)

### What the backtest tests:
- 5 assets (SOL 22%, BTC 20%, ETH 13%, JTO 23%, INJ 22%)
- 2x leverage, 7% APY entry threshold
- 48h flip confirmation + 48h cooldown
- 0.088% round-trip fees (ideal) or 0.30% (realistic)

---

## Helius Integration

We use Helius for:
1. **Priority fees** — `src/utils/helius-enhanced.ts` for `getPriorityFeeEstimate()` per transaction
2. **Webhooks** — `scripts/create-helius-webhook.ts` monitors vault account changes
3. **DAS API** — token balances, parsed transaction history
4. **RPC** — all Drift SDK calls go through Helius RPC

Config: `HELIUS_RPC_URL` in .env

---

## Simulation / Devnet Plan

### To demonstrate live execution:
```bash
npm run devnet:setup         # Create wallet, airdrop SOL, init Drift account
npm run devnet:dry-run       # Full strategy pipeline (fetch rates -> signal -> execute)
npm run devnet:strategy      # Extended multi-cycle test
```

### Adaptor CPI (already verified on devnet):
```
Initialize tx: 3o8rLDXGQUyyyq...
Deposit tx:    5C1eN2yctzq4B2...
Withdraw tx:   vp7hBrvnCqL5QV...
```

---

## Remaining Tasks (Priority Order)

### Must Do (before April 6)

| # | Task | Time | Status |
|---|---|---|---|
| 1 | Run realistic backtest | 10 min | DONE (+44.88% CAGR) |
| 2 | Run devnet dry run and capture output for demo | 30 min | DONE (tx: 2cGsXk3t...) |
| 3 | Record 3-min demo video | 1-2 hours | NOT DONE |
| 4 | Submit on Superteam Earn (both tracks) | 30 min | NOT DONE |
| 5 | Add @jakeyvee on GitHub (if private) | 2 min | NOT DONE |

### Should Do

| # | Task | Time | Status |
|---|---|---|---|
| 6 | Confirm 181/181 tests pass | 1 min | DONE |
| 7 | Clean up submission docs | 30 min | PARTIALLY DONE |
| 8 | Create strategies.json for vault | 5 min | DONE |
| 9 | Document on-chain adaptor | 30 min | DONE |

### Nice to Have

| # | Task | Time | Status |
|---|---|---|---|
| 10 | Try mainnet with $10-20 for real transactions | 1 hour | NOT DONE |
| 11 | Deploy custom_adaptor_completed to devnet | 30 min | NOT DONE |

---

## Key Files (What Judges Should Look At)

### Strategy (the brain):
- `src/strategy/engine.ts` — 2,328 lines, core strategy engine
- `src/strategy/floating-maker.ts` — 450 lines, DLOB market making
- `src/drift/jit-maker.ts` — 726 lines, JIT auction fills
- `src/drift/filler.ts` — 599 lines, DLOB order filling

### Execution:
- `src/drift/executor.ts` — 1,498 lines, atomic txs + Jito bundles + simulation
- `src/agent/index.ts` — 954 lines, orchestration + lifecycle
- `scripts/rebalance-bot/rebalance_loop.ts` — Voltr-compatible rebalance

### On-Chain:
- `programs/driftbear_custom_adaptor/src/lib.rs` — 1,058 lines Rust, CPI to Drift
- `programs/custom_adaptor_completed/src/lib.rs` — Workshop 2 completed solution
- `Anchor.toml` — program IDs + devnet config

### Risk:
- `src/strategy/circuit-breaker.ts` — 6-trigger emergency stop
- `src/risk/manager.ts` — health/drawdown/leverage
- `src/risk/oracle-guard.ts` — oracle staleness detection

### Documentation:
- `docs/ON_CHAIN_PROGRAMS.md` — deployed programs + verified txs
- `MAIN_TRACK_SUBMISSION.md` — Ranger track submission
- `DRIFT_TRACK_SUBMISSION.md` — Drift track submission

---

## Available Commands

```bash
# Strategy
npm run agent                    # Start full strategy engine
npm run rebalance-bot            # Voltr-compatible rebalance loop

# Backtesting
npm run backtest:v2-s3           # Ideal assumptions (+45.76% CAGR)
npm run backtest:v2-s3-realistic # Worst-case assumptions (~+30% CAGR)

# Monitoring
npm run funding-monitor          # Funding rate dashboard
npm run health-guard             # Health monitoring
npm run dashboard                # Web dashboard (:3000)

# Vault
npm run vault:init / deposit / withdraw / status

# Devnet
npm run devnet:setup / dry-run / strategy

# Testing
npm test                         # 20 suites, 181 tests
```
