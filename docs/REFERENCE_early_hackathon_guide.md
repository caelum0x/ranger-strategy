# 🐻 Ranger Build-A-Bear Hackathon - Complete Strategy Guide

## Your Winning Strategy: Oracle-Floating Perp Market Maker Vault

---

# A) FLOATING PERP MAKER CODE DEEP DIVE

## Source Code Analysis

The `FloatingPerpMaker` bot is from `keeper-bots-v2/src/bots/floatingMaker.ts`. Here's the complete breakdown:

### Core Concept

```typescript
/**
 * This bot is responsible for placing limit orders that rest on the DLOB.
 * Limit price offsets are used to automatically shift the orders with the
 * oracle price, making order updating automatic.
 */
```

**Key Innovation:** Uses `oraclePriceOffset` instead of fixed prices. Orders automatically track the oracle, requiring minimal transactions.

---

### Key Parameters

```typescript
// Maximum position as % of collateral (10% default)
private MAX_POSITION_EXPOSURE = 0.1;

// Maximum quote to spend per order
private MAX_TRADE_SIZE_QUOTE = 1000;

// Cooldown between updates (in slots)
const MARKET_UPDATE_COOLDOWN_SLOTS = 30;
```

---

### How It Works (Step by Step)

#### 1. State Management
```typescript
type State = {
    marketPosition: Map<int, PerpPosition>;  // Current positions per market
    openOrders: Map<int, Array<Order>>;       // Active orders per market
};
```

#### 2. Price Calculation (The Magic)
```typescript
// Get oracle data
const oracle = this.driftClient.getMMOracleDataForPerpMarket(marketIndex);

// Calculate virtual bid/ask prices (includes spread)
const vAsk = calculateAskPrice(marketAccount, oracle);  // Higher price
const vBid = calculateBidPrice(marketAccount, oracle);  // Lower price

// Calculate spread from oracle
const oracleBidSpread = oracle.price.sub(vBid);  // Distance below oracle
const oracleAskSpread = vAsk.sub(oracle.price);  // Distance above oracle
```

#### 3. Order Placement (Oracle Offset)
```typescript
// BID ORDER (buy side) - below oracle
const tx0 = await this.driftClient.placePerpOrder({
    marketIndex: marketIndex,
    orderType: OrderType.LIMIT,
    direction: PositionDirection.LONG,
    baseAssetAmount: BASE_PRECISION.mul(new BN(1)),
    oraclePriceOffset: oracleBidSpread
        .mul(biasNum)      // 90/100 = 0.9 factor
        .div(biasDenom)
        .neg()             // NEGATIVE = below oracle
        .toNumber(),
});

// ASK ORDER (sell side) - above oracle
const tx1 = await this.driftClient.placePerpOrder({
    marketIndex: marketIndex,
    orderType: OrderType.LIMIT,
    direction: PositionDirection.SHORT,
    baseAssetAmount: BASE_PRECISION.mul(new BN(1)),
    oraclePriceOffset: oracleAskSpread
        .mul(biasNum)      // 90/100 = 0.9 factor
        .div(biasDenom)
        .toNumber(),       // POSITIVE = above oracle
});
```

#### 4. The `biasNum/biasDenom` Factor (90/100)
```
This makes your orders MORE COMPETITIVE than the default spread:

If vBid = oracle - 10 bps
Your bid = oracle - 9 bps (closer to oracle = better price for taker)

If vAsk = oracle + 10 bps  
Your ask = oracle + 9 bps (closer to oracle = better price for taker)

Result: Your orders are more likely to fill!
```

#### 5. Order Management Flow
```typescript
private async updateOpenOrdersForMarket(marketAccount) {
    // 1. Check cooldown
    if (nextUpdateSlot > currSlot) return;

    // 2. Get current orders
    const openOrders = this.agentState.openOrders.get(marketIndex);

    // 3. If not exactly 2 orders, cancel all and replace
    let placeNewOrders = openOrders.length === 0;
    
    if (openOrders.length > 0 && openOrders.length != 2) {
        // Cancel existing orders
        for (const o of openOrders) {
            await this.driftClient.cancelOrder(o.orderId);
        }
        placeNewOrders = true;
    }

    // 4. Place new orders if needed
    if (placeNewOrders) {
        // Place bid and ask (see above)
    }
}
```

---

### Why This Works Better Than Delta-Neutral

| Delta-Neutral | FloatingPerpMaker |
|---------------|-------------------|
| Hope funding goes your way | You ARE the market |
| Pay fees on every trade | Earn maker rebates |
| PnL depends on market direction | PnL from spread capture |
| Needs perfect timing | Passive, always working |
| Complex hedging | Simple bid/ask placement |

---

# B) CUSTOM BOT ARCHITECTURE

## Enhanced Floating Maker for Your Vault

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    RANGER VAULT                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 DEPOSIT MANAGER                       │   │
│  │  • User deposits USDC                                 │   │
│  │  • Track vault shares                                 │   │
│  │  • Handle withdrawals                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              STRATEGY CONTROLLER                      │   │
│  │  • Risk management                                    │   │
│  │  • Position limits                                    │   │
│  │  • Drawdown monitoring                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              DRIFT ADAPTOR                            │   │
│  │  • FloatingPerpMaker logic                            │   │
│  │  • Oracle offset orders                               │   │
│  │  • Position rebalancing                               │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│                    DRIFT PROTOCOL                            │
│                    (DLOB + Perps)                            │
└─────────────────────────────────────────────────────────────┘
```

---

### TypeScript Implementation

```typescript
// vault-strategy.ts

import {
    DriftClient,
    SlotSubscriber,
    calculateAskPrice,
    calculateBidPrice,
    PositionDirection,
    OrderType,
    BASE_PRECISION,
    BN,
} from '@drift-labs/sdk';

// ============================================
// CONFIGURATION
// ============================================

interface VaultConfig {
    // Markets to make (SOL-PERP, ETH-PERP, etc.)
    markets: number[];

    // Spread parameters
    spreadBiasNumerator: number;      // Default: 90
    spreadBiasDenominator: number;    // Default: 100

    // Position limits
    maxPositionExposure: number;      // Default: 0.1 (10% of collateral)
    maxTradeSizeQuote: number;        // Default: 1000 USDC

    // Risk management
    maxDrawdown: number;              // Default: 0.05 (5%)
    oracleStalenessThreshold: number; // Default: 60 seconds

    // Order parameters
    orderRefreshSlots: number;        // Default: 30 slots
}

const DEFAULT_CONFIG: VaultConfig = {
    markets: [0, 1],  // SOL-PERP, ETH-PERP
    spreadBiasNumerator: 90,
    spreadBiasDenominator: 100,
    maxPositionExposure: 0.1,
    maxTradeSizeQuote: 1000,
    maxDrawdown: 0.05,
    oracleStalenessThreshold: 60,
    orderRefreshSlots: 30,
};

// ============================================
// VAULT STATE
// ============================================

interface VaultState {
    totalDeposits: BN;
    totalShares: BN;
    pnl: number;
    peakValue: number;
    currentPosition: Map<number, Position>;
    openOrders: Map<number, Order[]>;
}

// ============================================
// MAIN STRATEGY CLASS
// ============================================

export class VaultFloatingMaker {
    private driftClient: DriftClient;
    private slotSubscriber: SlotSubscriber;
    private config: VaultConfig;
    private state: VaultState;

    constructor(
        driftClient: DriftClient,
        slotSubscriber: SlotSubscriber,
        config: VaultConfig = DEFAULT_CONFIG
    ) {
        this.driftClient = driftClient;
        this.slotSubscriber = slotSubscriber;
        this.config = config;
        this.state = this.initializeState();
    }

    // ============================================
    // CORE STRATEGY LOGIC
    // ============================================

    async updateMarket(marketIndex: number): Promise<void> {
        // 1. Check if we should update (cooldown)
        if (!this.shouldUpdate(marketIndex)) {
            return;
        }

        // 2. Get market data
        const market = this.driftClient.getPerpMarketAccount(marketIndex);
        const oracle = this.driftClient.getMMOracleDataForPerpMarket(marketIndex);

        // 3. Check oracle validity
        if (this.isOracleStale(oracle)) {
            console.warn(`Oracle stale for market ${marketIndex}, skipping`);
            return;
        }

        // 4. Calculate prices
        const vAsk = calculateAskPrice(market, oracle);
        const vBid = calculateBidPrice(market, oracle);

        // 5. Get current position
        const position = this.getCurrentPosition(marketIndex);

        // 6. Adjust spreads based on inventory
        const { bidOffset, askOffset } = this.calculateInventoryAdjustedSpread(
            position,
            oracle.price,
            vBid,
            vAsk
        );

        // 7. Get position size (with risk management)
        const orderSize = this.calculateOrderSize(marketIndex);

        // 8. Cancel existing orders
        await this.cancelOrdersForMarket(marketIndex);

        // 9. Place new orders
        await this.placeOrders(marketIndex, orderSize, bidOffset, askOffset);

        // 10. Update last update slot
        this.updateLastSlot(marketIndex);
    }

    // ============================================
    // INVENTORY-BASED SPREAD ADJUSTMENT
    // ============================================

    private calculateInventoryAdjustedSpread(
        position: Position,
        oraclePrice: BN,
        vBid: BN,
        vAsk: BN
    ): { bidOffset: number; askOffset: number } {
        const { spreadBiasNumerator: num, spreadBiasDenominator: den } = this.config;

        // Base spreads
        let bidSpread = oraclePrice.sub(vBid).mul(num).div(den).toNumber();
        let askSpread = vAsk.sub(oraclePrice).mul(num).div(den).toNumber();

        // Adjust based on inventory (skew away from accumulated position)
        if (position && !position.baseAssetAmount.isZero()) {
            const inventoryRatio = this.calculateInventoryRatio(position);

            if (position.baseAssetAmount.gt(new BN(0))) {
                // LONG position - make bid wider (less attractive)
                // Make ask tighter (more attractive to close position)
                bidSpread *= (1 + inventoryRatio * 0.5);  // Widen bid
                askSpread *= (1 - inventoryRatio * 0.3);  // Tighten ask
            } else {
                // SHORT position - make ask wider (less attractive)
                // Make bid tighter (more attractive to close position)
                bidSpread *= (1 - inventoryRatio * 0.3);  // Tighten bid
                askSpread *= (1 + inventoryRatio * 0.5);  // Widen ask
            }
        }

        return {
            bidOffset: -Math.floor(bidSpread),  // Negative = below oracle
            askOffset: Math.floor(askSpread),   // Positive = above oracle
        };
    }

    // ============================================
    // RISK MANAGEMENT
    // ============================================

    private calculateOrderSize(marketIndex: number): BN {
        const collateral = this.getAvailableCollateral();
        const maxSize = new BN(this.config.maxTradeSizeQuote);

        // Check current position
        const position = this.getCurrentPosition(marketIndex);
        if (position) {
            const positionValue = this.calculatePositionValue(position);
            const maxPositionValue = collateral.muln(this.config.maxPositionExposure);

            // Reduce order size if approaching limit
            if (positionValue.gt(maxPositionValue.muln(0.8))) {
                return maxSize.divn(2);  // Halve order size
            }
        }

        return maxSize;
    }

    private checkDrawdown(): boolean {
        const currentPnL = this.calculateCurrentPnL();
        const drawdown = (this.state.peakValue - currentPnL) / this.state.peakValue;

        if (drawdown > this.config.maxDrawdown) {
            console.error(`Drawdown limit reached: ${(drawdown * 100).toFixed(2)}%`);
            this.triggerEmergencyStop();
            return false;
        }

        return true;
    }

    private triggerEmergencyStop(): void {
        // Cancel all orders
        for (const [marketIndex] of this.state.openOrders) {
            this.cancelOrdersForMarket(marketIndex);
        }

        // Close positions (market order)
        for (const [marketIndex, position] of this.state.currentPosition) {
            if (!position.baseAssetAmount.isZero()) {
                this.closePosition(marketIndex);
            }
        }

        // Alert via notification system
        this.sendAlert('EMERGENCY_STOP', 'Drawdown limit reached, all positions closed');
    }

    // ============================================
    // ORDER EXECUTION
    // ============================================

    private async placeOrders(
        marketIndex: number,
        size: BN,
        bidOffset: number,
        askOffset: number
    ): Promise<void> {
        // Place BID (buy order)
        const bidTx = await this.driftClient.placePerpOrder({
            marketIndex,
            orderType: OrderType.LIMIT,
            direction: PositionDirection.LONG,
            baseAssetAmount: size,
            oraclePriceOffset: bidOffset,
            postOnly: true,  // Ensure maker order
        });

        console.log(`[${marketIndex}] Placed BID: ${bidTx}`);

        // Place ASK (sell order)
        const askTx = await this.driftClient.placePerpOrder({
            marketIndex,
            orderType: OrderType.LIMIT,
            direction: PositionDirection.SHORT,
            baseAssetAmount: size,
            oraclePriceOffset: askOffset,
            postOnly: true,  // Ensure maker order
        });

        console.log(`[${marketIndex}] Placed ASK: ${askTx}`);
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    private shouldUpdate(marketIndex: number): boolean {
        const currentSlot = this.slotSubscriber.currentSlot;
        const lastSlot = this.state.lastUpdateSlot.get(marketIndex) || 0;
        return currentSlot - lastSlot >= this.config.orderRefreshSlots;
    }

    private isOracleStale(oracle: OracleData): boolean {
        const now = Date.now() / 1000;
        const oracleTime = oracle.lastUpdatedTs.toNumber();
        return (now - oracleTime) > this.config.oracleStalenessThreshold;
    }

    private calculateInventoryRatio(position: Position): number {
        const collateral = this.getAvailableCollateral();
        const positionValue = this.calculatePositionValue(position);
        return positionValue.toNumber() / (collateral.toNumber() * this.config.maxPositionExposure);
    }
}

// ============================================
// MAIN LOOP
// ============================================

async function runStrategy() {
    const driftClient = await initializeDriftClient();
    const slotSubscriber = new SlotSubscriber({ driftClient });
    await slotSubscriber.subscribe();

    const strategy = new VaultFloatingMaker(driftClient, slotSubscriber);

    // Run every 5 seconds
    setInterval(async () => {
        for (const marketIndex of strategy.config.markets) {
            try {
                await strategy.updateMarket(marketIndex);
            } catch (error) {
                console.error(`Error updating market ${marketIndex}:`, error);
            }
        }
    }, 5000);
}
```

---

### Rust Implementation (For On-Chain Vault)

```rust
// programs/vault/src/lib.rs

use anchor_lang::prelude::*;
use drift::cpi::accounts::PlacePerpOrder;
use drift::program::Drift;

declare_id!("YOUR_VAULT_PROGRAM_ID");

#[program]
pub mod vault_strategy {
    use super::*;

    /// Initialize vault
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        config: VaultConfig,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.total_deposits = 0;
        vault.total_shares = 0;
        vault.config = config;
        Ok(())
    }

    /// Deposit USDC into vault
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Transfer USDC from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Calculate shares
        let shares = if vault.total_shares == 0 {
            amount
        } else {
            amount * vault.total_shares / vault.total_deposits
        };

        vault.total_deposits += amount;
        vault.total_shares += shares;

        Ok(())
    }

    /// Execute market making strategy via CPI to Drift
    pub fn execute_strategy(
        ctx: Context<ExecuteStrategy>,
        market_index: u16,
        bid_offset: i64,
        ask_offset: i64,
        size: u64,
    ) -> Result<()> {
        // Place bid order via CPI to Drift
        let cpi_accounts = PlacePerpOrder {
            // ... Drift CPI accounts
        };
        
        let cpi_program = ctx.accounts.drift_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        
        drift::cpi::place_perp_order(
            cpi_ctx,
            market_index,
            OrderType::Limit,
            PositionDirection::Long,
            size,
            bid_offset,
        )?;

        // Place ask order via CPI to Drift
        // ... similar CPI call

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VaultConfig {
    pub markets: Vec<u16>,
    pub max_position_exposure: u64,  // In basis points
    pub max_drawdown: u64,           // In basis points
    pub spread_bias_numerator: u64,
    pub spread_bias_denominator: u64,
}

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub total_shares: u64,
    pub config: VaultConfig,
    pub positions: Vec<Position>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Position {
    pub market_index: u16,
    pub base_asset_amount: i64,
    pub quote_asset_amount: u64,
    pub entry_price: u64,
}
```

---

# C) RANGER VAULT INTEGRATION

## Integration Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         USER FLOW                               │
│                                                                  │
│  User ──► Deposit USDC ──► Ranger Vault ──► Your Strategy      │
│         (via Ranger SDK)   (On-chain)      (CPI to Drift)       │
│                                                                  │
│  User ◄── Withdraw USDC ◄─ Ranger Vault ◄── Your Strategy      │
│         (via Ranger SDK)   (On-chain)       (Close positions)   │
└────────────────────────────────────────────────────────────────┘
```

## Key Integration Points

### 1. Vault Setup via Ranger SDK

```typescript
import { RangerClient } from '@ranger-earn/sdk';

// Initialize Ranger client
const rangerClient = new RangerClient({
    rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
    wallet: yourKeypair,
});

// Create a new vault
const vault = await rangerClient.createVault({
    name: "Drift Floating MM Vault",
    description: "Market making vault using oracle-offset orders",
    baseAsset: "USDC",
    strategyType: "MARKET_MAKING",
    feeStructure: {
        managementFee: 0,           // 0% management fee
        performanceFee: 1000,       // 10% performance fee (in basis points)
        withdrawalFee: 0,           // 0% withdrawal fee
    },
    constraints: {
        minDeposit: 100,            // Min 100 USDC
        maxDeposit: 1000000,        // Max 1M USDC
        lockupPeriod: 7776000,      // 3 months in seconds
    },
});

console.log('Vault created:', vault.address.toString());
```

### 2. Strategy Integration via CPI

```typescript
// When your vault needs to execute trades on Drift
async function executeDriftTrade(vault: Vault, params: TradeParams) {
    // Build CPI instruction to Drift
    const driftIx = await buildDriftCPI({
        vaultProgram: VAULT_PROGRAM_ID,
        driftProgram: DRIFT_PROGRAM_ID,
        vaultAccount: vault.address,
        marketIndex: params.marketIndex,
        orderType: OrderType.LIMIT,
        direction: params.direction,
        size: params.size,
        oraclePriceOffset: params.offset,
    });

    // Execute via Ranger's executeStrategy
    const tx = await rangerClient.executeStrategy({
        vault: vault.address,
        instructions: [driftIx],
        authority: yourKeypair,
    });

    return tx;
}
```

### 3. Custom Adaptor Pattern

```typescript
// drift-adaptor.ts

import { Program } from '@project-serum/anchor';

export class DriftAdaptor {
    private program: Program;
    private driftProgram: Program;

    constructor(program: Program, driftProgram: Program) {
        this.program = program;
        this.driftProgram = driftProgram;
    }

    /// Execute floating maker strategy
    async executeFloatingMaker(
        vault: PublicKey,
        markets: number[],
        config: MakerConfig
    ): Promise<TransactionSignature[]> {
        const txs: TransactionSignature[] = [];

        for (const marketIndex of markets) {
            // Get oracle price
            const oracle = await this.getOraclePrice(marketIndex);

            // Calculate offsets
            const { bidOffset, askOffset } = this.calculateOffsets(
                oracle,
                config
            );

            // Place orders via CPI
            const tx = await this.program.methods
                .executeStrategy(marketIndex, bidOffset, askOffset, config.size)
                .accounts({
                    vault,
                    driftProgram: this.driftProgram.programId,
                    // ... other accounts
                })
                .rpc();

            txs.push(tx);
        }

        return txs;
    }
}
```

### 4. State Synchronization

```typescript
// Sync vault state with Drift positions
async function syncVaultState(vault: PublicKey) {
    // Get vault on-chain state
    const vaultState = await rangerClient.getVault(vault);

    // Get Drift positions
    const driftPositions = await driftClient.getUser().getPositions();

    // Calculate NAV
    const nav = calculateNAV(vaultState, driftPositions);

    // Update vault metrics
    await rangerClient.updateVaultMetrics(vault, {
        nav,
        positions: driftPositions,
        lastUpdate: Date.now(),
    });

    return nav;
}
```

---

# D) STRATEGY DOCUMENTATION

## Strategy Name: Oracle-Floating Perp Market Maker Vault

### Executive Summary

This vault implements an automated market making strategy on Drift Protocol's decentralized limit order book (DLOB). By using oracle-price-offset orders that automatically track the oracle price, the vault captures bid-ask spread with minimal transaction costs and directional exposure.

---

### Strategy Thesis

**Core Insight:** Traditional market makers on centralized exchanges profit from bid-ask spread capture. On Drift's DLOB, we can replicate this model with oracle-offset orders that require minimal maintenance transactions.

**Why This Works:**
1. **Spread Capture:** Every fill captures the bid-ask spread
2. **Maker Rebates:** Drift rewards makers with fee discounts
3. **Low Maintenance:** Oracle-offset orders auto-track price
4. **Inventory Management:** Dynamic spread adjustment based on position

---

### How It Works

#### 1. Order Placement
```
At any given time, the vault maintains two orders per market:

BID: Buy at Oracle - X bps (below current price)
ASK: Sell at Oracle + X bps (above current price)

When either fills, the vault captures the spread.
```

#### 2. Oracle Offset Mechanism
```
Instead of fixed prices, orders use oraclePriceOffset:

- Bid offset: -50 (50 ticks below oracle)
- Ask offset: +50 (50 ticks above oracle)

As oracle moves, orders automatically stay at same relative position.
No need to cancel/repost orders constantly.
```

#### 3. Inventory-Based Spreading
```
When position builds up, spreads adjust to encourage closing:

LONG position buildup:
  → Widen bid (harder to accumulate more)
  → Tighten ask (easier to close position)

SHORT position buildup:
  → Tighten bid (easier to close position)
  → Widen ask (harder to accumulate more)
```

---

### Risk Management

#### 1. Position Limits
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max Position Exposure | 10% of collateral | Limit directional risk |
| Max Trade Size | $1,000 per order | Limit fill size |
| Max Markets | 2-3 | Concentrate liquidity |

#### 2. Drawdown Protection
| Level | Drawdown | Action |
|-------|----------|--------|
| Warning | 3% | Alert, reduce position sizes |
| Critical | 5% | Emergency stop, close all positions |
| Maximum | 10% | Vault pause, manual review |

#### 3. Oracle Validation
```
Before placing orders:
1. Check oracle last update timestamp
2. Reject if older than 60 seconds
3. Verify price within reasonable range
```

#### 4. Circuit Breakers
```
Trigger conditions:
- Oracle stale for > 60 seconds
- Position exceeds 15% of collateral
- Fill rate drops below 10% of orders placed
- Network congestion (slot time > 500ms)

Action: Cancel all orders, pause strategy
```

---

### Expected Performance

| Metric | Conservative | Moderate | Aggressive |
|--------|-------------|----------|------------|
| Daily Trades | 4 | 8 | 12 |
| Spread per Trade | 0.05% | 0.05% | 0.05% |
| Daily Return | 0.10% | 0.20% | 0.30% |
| Annualized APY | 36.5% | 73% | 109.5% |

**Note:** These are estimates. Actual returns depend on market volatility and competition.

---

### Fee Structure

| Fee Type | Rate | Notes |
|----------|------|-------|
| Management Fee | 0% | No management fee |
| Performance Fee | 10% | On profits above high water mark |
| Withdrawal Fee | 0% | No withdrawal fee |

---

### Operational Requirements

1. **Infrastructure:**
   - Dedicated server or VPS (AWS, GCP)
   - 99.9% uptime target
   - Helius RPC (you have this ✅)

2. **Monitoring:**
   - Prometheus metrics (built into bot)
   - Discord/Telegram alerts
   - Daily PnL reports

3. **Backup:**
   - Secondary RPC endpoint
   - Emergency stop capability
   - Manual override access

---

### Deployment Plan

#### Phase 1: Testing (Week 1)
- [ ] Run bot on devnet
- [ ] Verify order placement
- [ ] Test risk management triggers

#### Phase 2: Soft Launch (Week 2)
- [ ] Deploy to mainnet with $500-1000
- [ ] Monitor for 48 hours
- [ ] Verify positive PnL

#### Phase 3: Scale (Week 3-4)
- [ ] Increase capital if profitable
- [ ] Add additional markets
- [ ] Submit to hackathon

---

### Appendix A: Technical Specifications

**Drift Integration:**
- SDK: `@drift-labs/sdk` v2.x
- Markets: SOL-PERP (0), ETH-PERP (1)
- Order Type: LIMIT with oraclePriceOffset
- Commitment: processed (for lowest latency)

**Ranger Integration:**
- SDK: `@ranger-earn/sdk`
- Vault Type: Custom Strategy
- Base Asset: USDC

**Infrastructure:**
- Runtime: Node.js 18+
- RPC: Helius Dedicated
- Monitoring: Prometheus + Grafana

---

### Appendix B: Code Repository Structure

```
vault-floating-maker/
├── programs/
│   └── vault/
│       ├── src/
│       │   ├── lib.rs          # Vault program
│       │   ├── strategy.rs     # Strategy logic
│       │   └── drift_cpi.rs    # Drift integration
│       └── Cargo.toml
├── sdk/
│   ├── src/
│   │   ├── index.ts
│   │   ├── vault-client.ts    # Ranger client
│   │   └── drift-adaptor.ts   # Drift adaptor
│   └── package.json
├── bots/
│   ├── src/
│   │   ├── floating-maker.ts  # Bot logic
│   │   ├── risk-manager.ts    # Risk management
│   │   └── monitor.ts         # Monitoring
│   └── package.json
├── docs/
│   ├── STRATEGY.md
│   ├── API.md
│   └── DEPLOYMENT.md
└── README.md
```

---

## Next Steps

1. **Today:** Clone keeper-bots-v2, run FloatingPerpMaker on devnet
2. **Tomorrow:** Modify with your risk parameters, test on mainnet with $100-500
3. **Week 2:** Integrate with Ranger vault structure
4. **Week 3-4:** Document, scale, submit

---

**Questions?** Reach out on the Ranger Telegram: https://t.me/+[ranger-hackathon]
