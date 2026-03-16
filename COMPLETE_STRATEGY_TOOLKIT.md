# 🛠️ Complete Strategy Toolkit - Ranger Hackathon

## Table of Contents
1. Circuit Breaker Implementation (Delta-Neutral Fix)
2. DLOB Market Making Bot (FloatingPerpMaker)
3. Hybrid Strategy Design (Combined Approach)
4. Cross-Venue Arbitrage (Binance + Drift)

---

# 1️⃣ CIRCUIT BREAKER IMPLEMENTATION

## The Problem You Solved

```
307 direction flips × $5.35/flip = $1,644 in fees
Gross funding: $285
Result: -$17 loss

WITH circuit breaker:
20 flips × $5.35/flip = $107 in fees
Gross funding: $285
Result: +$118 profit ✅
```

## Complete Implementation

```typescript
// strategies/delta-neutral/circuit-breaker.ts

import { EventEmitter } from 'events';

export interface CircuitBreakerConfig {
    // Minimum time between position flips
    flipCooldownMs: number;           // Default: 24 hours

    // Minimum funding rate change to trigger flip
    minFundingRateChange: number;     // Default: 0.0001 (1 bp)

    // Maximum flips per day
    maxFlipsPerDay: number;           // Default: 1

    // Emergency: pause if daily loss exceeds this
    maxDailyLossPercent: number;      // Default: 0.02 (2%)

    // Minimum funding rate to enter position
    minFundingRateToEnter: number;    // Default: 0.00005 (0.5 bp)
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
    flipCooldownMs: 24 * 60 * 60 * 1000,    // 24 hours
    minFundingRateChange: 0.0001,           // 1 basis point
    maxFlipsPerDay: 1,                       // Max 1 flip per day
    maxDailyLossPercent: 0.02,              // 2% max daily loss
    minFundingRateToEnter: 0.00005,         // 0.5 basis point minimum
};

export class CircuitBreaker extends EventEmitter {
    private config: CircuitBreakerConfig;
    private lastFlipTime: number = 0;
    private flipsToday: number = 0;
    private dayStartTime: number = Date.now();
    private dailyPnL: number = 0;
    private isPaused: boolean = false;
    private pauseReason: string = '';

    constructor(config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG) {
        super();
        this.config = config;
    }

    /**
     * Check if we can flip the position
     */
    canFlip(currentFundingRate: number, previousFundingRate: number): {
        allowed: boolean;
        reason: string;
        waitTime?: number;
    } {
        // Check if paused
        if (this.isPaused) {
            return { allowed: false, reason: `PAUSED: ${this.pauseReason}` };
        }

        const now = Date.now();

        // Reset daily counters
        this.resetDailyCountersIfNeeded();

        // Check flip cooldown
        const timeSinceLastFlip = now - this.lastFlipTime;
        if (timeSinceLastFlip < this.config.flipCooldownMs) {
            const waitTime = this.config.flipCooldownMs - timeSinceLastFlip;
            return {
                allowed: false,
                reason: 'COOLDOWN_ACTIVE',
                waitTime,
            };
        }

        // Check max flips per day
        if (this.flipsToday >= this.config.maxFlipsPerDay) {
            return { allowed: false, reason: 'MAX_FLIPS_REACHED' };
        }

        // Check funding rate change is significant
        const fundingChange = Math.abs(currentFundingRate - previousFundingRate);
        if (fundingChange < this.config.minFundingRateChange) {
            return {
                allowed: false,
                reason: 'INSUFFICIENT_FUNDING_CHANGE',
            };
        }

        // Check minimum funding rate to flip
        if (Math.abs(currentFundingRate) < this.config.minFundingRateToEnter) {
            return { allowed: false, reason: 'FUNDING_RATE_TOO_LOW' };
        }

        return { allowed: true, reason: 'OK' };
    }

    /**
     * Record a flip - call this AFTER executing the flip
     */
    recordFlip(): void {
        this.lastFlipTime = Date.now();
        this.flipsToday++;
        this.emit('flip_recorded', {
            time: this.lastFlipTime,
            flipsToday: this.flipsToday,
        });
    }

    /**
     * Update daily P&L and check for emergency stop
     */
    updatePnL(pnl: number, equity: number): boolean {
        this.dailyPnL += pnl;

        // Check if we've exceeded max daily loss
        const dailyLossPercent = Math.abs(this.dailyPnL) / equity;
        if (this.dailyPnL < 0 && dailyLossPercent > this.config.maxDailyLossPercent) {
            this.pause('DAILY_LOSS_LIMIT');
            return false;
        }

        return true;
    }

    /**
     * Pause the strategy
     */
    pause(reason: string): void {
        this.isPaused = true;
        this.pauseReason = reason;
        this.emit('paused', { reason, time: Date.now() });
        console.warn(`[CIRCUIT BREAKER] PAUSED: ${reason}`);
    }

    /**
     * Resume the strategy (manual override)
     */
    resume(): void {
        this.isPaused = false;
        this.pauseReason = '';
        this.emit('resumed', { time: Date.now() });
        console.log('[CIRCUIT BREAKER] RESUMED');
    }

    /**
     * Get current state
     */
    getState(): {
        isPaused: boolean;
        pauseReason: string;
        lastFlipTime: number;
        flipsToday: number;
        dailyPnL: number;
        timeUntilNextFlip: number;
    } {
        const now = Date.now();
        this.resetDailyCountersIfNeeded();

        const timeSinceLastFlip = now - this.lastFlipTime;
        const timeUntilNextFlip = Math.max(
            0,
            this.config.flipCooldownMs - timeSinceLastFlip
        );

        return {
            isPaused: this.isPaused,
            pauseReason: this.pauseReason,
            lastFlipTime: this.lastFlipTime,
            flipsToday: this.flipsToday,
            dailyPnL: this.dailyPnL,
            timeUntilNextFlip,
        };
    }

    private resetDailyCountersIfNeeded(): void {
        const now = Date.now();
        const msInDay = 24 * 60 * 60 * 1000;

        if (now - this.dayStartTime >= msInDay) {
            this.flipsToday = 0;
            this.dailyPnL = 0;
            this.dayStartTime = now;
        }
    }
}
```

## Integration with Your Delta-Neutral Strategy

```typescript
// strategies/delta-neutral/delta-neutral-manager.ts

import { DriftClient, PositionDirection, OrderType, BN } from '@drift-labs/sdk';
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from './circuit-breaker';

export class DeltaNeutralManager {
    private driftClient: DriftClient;
    private circuitBreaker: CircuitBreaker;
    private currentDirection: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
    private previousFundingRate: number = 0;
    private config: {
        marketIndex: number;
        positionSizeUsd: number;
        rebalanceIntervalMs: number;
        rebalanceThreshold: number;
    };

    constructor(
        driftClient: DriftClient,
        config: {
            marketIndex: number;
            positionSizeUsd: number;
            rebalanceIntervalMs: number;
            rebalanceThreshold: number;
        }
    ) {
        this.driftClient = driftClient;
        this.config = config;
        this.circuitBreaker = new CircuitBreaker({
            ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
            flipCooldownMs: 24 * 60 * 60 * 1000,  // 24 hours
            maxFlipsPerDay: 1,
            minFundingRateToEnter: 0.00005,
        });

        // Set up event listeners
        this.circuitBreaker.on('paused', ({ reason }) => {
            this.handleEmergencyStop(reason);
        });
    }

    /**
     * Main strategy loop - call this every hour
     */
    async runHourlyCheck(): Promise<{
        action: 'FLIP' | 'REBALANCE' | 'HOLD' | 'PAUSED';
        details: string;
    }> {
        // Get current funding rate
        const fundingRate = await this.getFundingRate(this.config.marketIndex);
        console.log(`[DELTA-NEUTRAL] Funding rate: ${(fundingRate * 100).toFixed(4)}%`);

        // Check circuit breaker
        const { allowed, reason, waitTime } = this.circuitBreaker.canFlip(
            fundingRate,
            this.previousFundingRate
        );

        // Determine desired direction based on funding
        const desiredDirection = this.getDesiredDirection(fundingRate);

        // Check if we need to flip
        if (desiredDirection !== this.currentDirection && desiredDirection !== 'NONE') {
            if (allowed) {
                console.log(`[DELTA-NEUTRAL] Flipping from ${this.currentDirection} to ${desiredDirection}`);
                await this.executeFlip(desiredDirection);
                this.circuitBreaker.recordFlip();
                this.currentDirection = desiredDirection;

                return { action: 'FLIP', details: `Flipped to ${desiredDirection}` };
            } else {
                console.log(`[DELTA-NEUTRAL] Flip blocked: ${reason}`);
                if (waitTime) {
                    console.log(`  Wait ${(waitTime / 1000 / 60).toFixed(0)} minutes`);
                }
            }
        }

        // Check for rebalance
        if (await this.needsRebalance()) {
            await this.executeRebalance();
            return { action: 'REBALANCE', details: 'Position rebalanced' };
        }

        this.previousFundingRate = fundingRate;
        return { action: 'HOLD', details: 'No action needed' };
    }

    /**
     * Determine desired position direction from funding rate
     */
    private getDesiredDirection(fundingRate: number): 'LONG' | 'SHORT' | 'NONE' {
        // Positive funding = longs pay shorts = be SHORT
        // Negative funding = shorts pay longs = be LONG

        if (fundingRate > 0.00005) {
            return 'SHORT';  // Collect funding
        } else if (fundingRate < -0.00005) {
            return 'LONG';   // Collect funding (shorts pay longs)
        } else {
            return 'NONE';   // Funding too low, don't position
        }
    }

    /**
     * Execute position flip
     */
    private async executeFlip(newDirection: 'LONG' | 'SHORT'): Promise<void> {
        console.log(`[DELTA-NEUTRAL] Executing flip to ${newDirection}`);

        // 1. Close existing position if any
        if (this.currentDirection !== 'NONE') {
            await this.closePosition();
        }

        // 2. Open new position
        await this.openPosition(newDirection);

        console.log(`[DELTA-NEUTRAL] Flip complete`);
    }

    /**
     * Open position with spot + perp hedge
     */
    private async openPosition(direction: 'LONG' | 'SHORT'): Promise<void> {
        const size = new BN(this.config.positionSizeUsd * 1e6); // Convert to micro USD

        if (direction === 'SHORT') {
            // SHORT perp (collect funding when positive)
            // + LONG spot (delta-neutral)

            // Deposit USDC as collateral
            await this.driftClient.deposit(
                size,
                0, // USDC spot market
                this.driftClient.getUserAccountPublicKey()
            );

            // Short the perp
            await this.driftClient.placePerpOrder({
                marketIndex: this.config.marketIndex,
                orderType: OrderType.MARKET,
                direction: PositionDirection.SHORT,
                baseAssetAmount: this.calculateBaseAmount(size),
            });

        } else {
            // LONG perp (collect funding when negative)
            // + SHORT spot (delta-neutral) - using perp as main position

            await this.driftClient.deposit(
                size,
                0,
                this.driftClient.getUserAccountPublicKey()
            );

            await this.driftClient.placePerpOrder({
                marketIndex: this.config.marketIndex,
                orderType: OrderType.MARKET,
                direction: PositionDirection.LONG,
                baseAssetAmount: this.calculateBaseAmount(size),
            });
        }
    }

    /**
     * Close all positions
     */
    private async closePosition(): Promise<void> {
        const user = this.driftClient.getUser();
        const perpPosition = user.getPerpPosition(this.config.marketIndex);

        if (perpPosition && !perpPosition.baseAssetAmount.isZero()) {
            const direction = perpPosition.baseAssetAmount.gt(new BN(0))
                ? PositionDirection.SHORT  // Close long
                : PositionDirection.LONG;   // Close short

            await this.driftClient.placePerpOrder({
                marketIndex: this.config.marketIndex,
                orderType: OrderType.MARKET,
                direction,
                baseAssetAmount: perpPosition.baseAssetAmount.abs(),
            });
        }

        // Withdraw all USDC
        const spotPosition = user.getSpotPosition(0);
        if (spotPosition && !spotPosition.balance.isZero()) {
            await this.driftClient.withdraw(
                spotPosition.balance,
                0,
                this.driftClient.getUserAccountPublicKey()
            );
        }
    }

    /**
     * Check if position needs rebalance
     */
    private async needsRebalance(): Promise<boolean> {
        const now = Date.now();
        // Implement your rebalance logic
        // Reduced from every 8h to every 24h
        return false; // Simplified
    }

    /**
     * Execute rebalance
     */
    private async executeRebalance(): Promise<void> {
        // Implement rebalance logic
        console.log('[DELTA-NEUTRAL] Rebalancing position');
    }

    /**
     * Handle emergency stop
     */
    private async handleEmergencyStop(reason: string): Promise<void> {
        console.error(`[DELTA-NEUTRAL] EMERGENCY STOP: ${reason}`);
        await this.closePosition();
    }

    /**
     * Get current funding rate from Drift
     */
    private async getFundingRate(marketIndex: number): Promise<number> {
        const market = this.driftClient.getPerpMarketAccount(marketIndex);
        const oracle = this.driftClient.getOracleDataForPerpMarket(marketIndex);

        // Funding rate = (mark price - index price) / index price
        const markPrice = market.amm.markPrice;
        const indexPrice = oracle.price;

        // Convert to funding rate
        return markPrice.sub(indexPrice).toNumber() / indexPrice.toNumber();
    }

    /**
     * Calculate base asset amount from USD notional
     */
    private calculateBaseAmount(usdNotional: BN): BN {
        // Simplified - you'd use actual price
        return usdNotional.divn(100); // Assuming price ~ $100
    }
}
```

---

# 2️⃣ DLOB MARKET MAKING BOT

## Complete FloatingPerpMaker Implementation

```typescript
// strategies/dlob-mm/floating-perp-maker.ts

import {
    DriftClient,
    SlotSubscriber,
    calculateAskPrice,
    calculateBidPrice,
    PositionDirection,
    OrderType,
    BASE_PRECISION,
    BN,
    PerpMarketAccount,
    OracleData,
    isVariant,
    PostOnlyParams,
} from '@drift-labs/sdk';
import { Mutex } from 'async-mutex';

export interface MarketMakerConfig {
    // Markets to make
    markets: number[];

    // Spread settings
    spreadBiasNumerator: number;      // 90
    spreadBiasDenominator: number;    // 100

    // Position limits
    maxPositionExposure: number;      // 0.1 = 10% of collateral
    maxTradeSizeQuote: number;        // $ per order

    // Risk management
    maxDrawdown: number;              // 0.05 = 5%
    oracleStalenessSeconds: number;   // 60

    // Order settings
    cooldownSlots: number;            // 30 slots between updates
    minSpreadBps: number;             // Minimum spread in basis points
    maxSpreadBps: number;             // Maximum spread in basis points
}

export const DEFAULT_MM_CONFIG: MarketMakerConfig = {
    markets: [0, 1],  // SOL-PERP, ETH-PERP
    spreadBiasNumerator: 90,
    spreadBiasDenominator: 100,
    maxPositionExposure: 0.1,
    maxTradeSizeQuote: 1000,
    maxDrawdown: 0.05,
    oracleStalenessSeconds: 60,
    cooldownSlots: 30,
    minSpreadBps: 3,
    maxSpreadBps: 20,
};

interface MarketState {
    position: BN;
    openOrders: Map<number, any>;
    lastUpdateSlot: number;
    peakValue: number;
    currentPnL: number;
}

export class FloatingPerpMaker {
    public readonly name: string = 'FloatingPerpMaker';
    private driftClient: DriftClient;
    private slotSubscriber: SlotSubscriber;
    private config: MarketMakerConfig;
    private mutex: Mutex = new Mutex();

    private marketStates: Map<number, MarketState> = new Map();
    private isRunning: boolean = false;
    private intervalId?: NodeJS.Timeout;

    constructor(
        driftClient: DriftClient,
        slotSubscriber: SlotSubscriber,
        config: MarketMakerConfig = DEFAULT_MM_CONFIG
    ) {
        this.driftClient = driftClient;
        this.slotSubscriber = slotSubscriber;
        this.config = config;
    }

    /**
     * Initialize the bot
     */
    async init(): Promise<void> {
        console.log(`[${this.name}] Initializing...`);

        // Initialize state for each market
        for (const marketIndex of this.config.markets) {
            this.marketStates.set(marketIndex, {
                position: new BN(0),
                openOrders: new Map(),
                lastUpdateSlot: 0,
                peakValue: 0,
                currentPnL: 0,
            });
        }

        // Sync current positions
        await this.syncPositions();

        console.log(`[${this.name}] Initialized for markets: ${this.config.markets.join(', ')}`);
    }

    /**
     * Start the main loop
     */
    async start(intervalMs: number = 5000): Promise<void> {
        console.log(`[${this.name}] Starting with ${intervalMs}ms interval`);

        this.isRunning = true;

        // Initial update
        await this.updateAllMarkets();

        // Start periodic updates
        this.intervalId = setInterval(async () => {
            if (this.isRunning) {
                await this.updateAllMarkets();
            }
        }, intervalMs);
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        console.log(`[${this.name}] Stopping...`);
        this.isRunning = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
        }

        // Cancel all orders
        await this.cancelAllOrders();
    }

    /**
     * Main update loop
     */
    private async updateAllMarkets(): Promise<void> {
        const release = await this.mutex.acquire();

        try {
            // Check overall risk
            if (!this.checkRiskLimits()) {
                console.warn(`[${this.name}] Risk limits exceeded, pausing`);
                return;
            }

            // Update each market
            for (const marketIndex of this.config.markets) {
                try {
                    await this.updateMarket(marketIndex);
                } catch (error) {
                    console.error(`[${this.name}] Error updating market ${marketIndex}:`, error);
                }
            }
        } finally {
            release();
        }
    }

    /**
     * Update a single market
     */
    private async updateMarket(marketIndex: number): Promise<void> {
        const state = this.marketStates.get(marketIndex);
        if (!state) return;

        const currentSlot = this.slotSubscriber.getSlot();

        // Check cooldown
        if (currentSlot - state.lastUpdateSlot < this.config.cooldownSlots) {
            return;
        }

        console.log(`[${this.name}] Updating market ${marketIndex}`);

        // Get market data
        const market = this.driftClient.getPerpMarketAccount(marketIndex);
        const oracle = this.driftClient.getOracleDataForPerpMarket(marketIndex);

        // Validate oracle
        if (this.isOracleStale(oracle)) {
            console.warn(`[${this.name}] Oracle stale for market ${marketIndex}`);
            return;
        }

        // Calculate spreads
        const { bidOffset, askOffset } = this.calculateSpreads(market, oracle, state);

        // Get current orders
        const openOrders = await this.getOpenOrders(marketIndex);

        // Determine if we need to update orders
        const needsUpdate = this.needsOrderUpdate(openOrders, bidOffset, askOffset);

        if (needsUpdate) {
            // Cancel existing orders
            await this.cancelOrdersForMarket(marketIndex);

            // Place new orders
            await this.placeOrders(marketIndex, bidOffset, askOffset);
        }

        // Update state
        state.lastUpdateSlot = currentSlot;
        this.marketStates.set(marketIndex, state);
    }

    /**
     * Calculate bid/ask spreads with inventory adjustment
     */
    private calculateSpreads(
        market: PerpMarketAccount,
        oracle: OracleData,
        state: MarketState
    ): { bidOffset: number; askOffset: number } {
        const { spreadBiasNumerator: num, spreadBiasDenominator: den } = this.config;

        // Calculate base spreads
        const vAsk = calculateAskPrice(market, oracle);
        const vBid = calculateBidPrice(market, oracle);

        let bidSpread = oracle.price.sub(vBid).mul(num).div(den).toNumber();
        let askSpread = vAsk.sub(oracle.price).mul(num).div(den).toNumber();

        // Apply minimum/maximum spread limits
        bidSpread = Math.max(bidSpread, this.config.minSpreadBps);
        askSpread = Math.max(askSpread, this.config.minSpreadBps);
        bidSpread = Math.min(bidSpread, this.config.maxSpreadBps);
        askSpread = Math.min(askSpread, this.config.maxSpreadBps);

        // Adjust for inventory skew
        const inventoryAdjustment = this.calculateInventoryAdjustment(state);

        if (inventoryAdjustment !== 0) {
            if (inventoryAdjustment > 0) {
                // Long position - widen bid, tighten ask
                bidSpread = Math.floor(bidSpread * (1 + inventoryAdjustment * 0.5));
                askSpread = Math.floor(askSpread * (1 - inventoryAdjustment * 0.3));
            } else {
                // Short position - tighten bid, widen ask
                bidSpread = Math.floor(bidSpread * (1 + inventoryAdjustment * 0.3));
                askSpread = Math.floor(askSpread * (1 - inventoryAdjustment * 0.5));
            }
        }

        // Ensure minimum spread after adjustment
        bidSpread = Math.max(bidSpread, this.config.minSpreadBps);
        askSpread = Math.max(askSpread, this.config.minSpreadBps);

        return {
            bidOffset: -bidSpread,  // Negative = below oracle
            askOffset: askSpread,   // Positive = above oracle
        };
    }

    /**
     * Calculate inventory adjustment factor (-1 to 1)
     */
    private calculateInventoryAdjustment(state: MarketState): number {
        if (state.position.isZero()) return 0;

        const collateral = this.getCollateralValue();
        const positionValue = state.position.abs().toNumber();

        const exposure = positionValue / collateral;
        const maxExposure = this.config.maxPositionExposure;

        // Return adjustment factor based on how close we are to max exposure
        if (exposure >= maxExposure) {
            return Math.sign(state.position.toNumber()); // Max skew
        }

        return (exposure / maxExposure) * Math.sign(state.position.toNumber());
    }

    /**
     * Place bid and ask orders
     */
    private async placeOrders(
        marketIndex: number,
        bidOffset: number,
        askOffset: number
    ): Promise<void> {
        const orderSize = this.calculateOrderSize(marketIndex);

        console.log(`[${this.name}] Placing orders for market ${marketIndex}`);
        console.log(`  Bid offset: ${bidOffset}, Ask offset: ${askOffset}`);
        console.log(`  Size: ${orderSize.toString()}`);

        // Place BID (buy order)
        const bidTx = await this.driftClient.placePerpOrder({
            marketIndex,
            orderType: OrderType.LIMIT,
            direction: PositionDirection.LONG,
            baseAssetAmount: orderSize,
            oraclePriceOffset: bidOffset,
            postOnlyParams: PostOnlyParams.MUST_POST_ONLY,  // Maker only
        });
        console.log(`  Bid placed: ${bidTx}`);

        // Place ASK (sell order)
        const askTx = await this.driftClient.placePerpOrder({
            marketIndex,
            orderType: OrderType.LIMIT,
            direction: PositionDirection.SHORT,
            baseAssetAmount: orderSize,
            oraclePriceOffset: askOffset,
            postOnlyParams: PostOnlyParams.MUST_POST_ONLY,  // Maker only
        });
        console.log(`  Ask placed: ${askTx}`);
    }

    /**
     * Calculate appropriate order size
     */
    private calculateOrderSize(marketIndex: number): BN {
        const collateral = this.getCollateralValue();
        const state = this.marketStates.get(marketIndex);

        // Base size
        let size = new BN(this.config.maxTradeSizeQuote);

        // Reduce if approaching position limit
        if (state && !state.position.isZero()) {
            const currentExposure = state.position.abs().toNumber() / collateral;
            const maxExposure = this.config.maxPositionExposure;

            if (currentExposure > maxExposure * 0.8) {
                size = size.divn(2);  // Halve the size
            }
            if (currentExposure > maxExposure * 0.9) {
                size = size.divn(4);  // Quarter the size
            }
        }

        return size.mul(BASE_PRECISION);
    }

    /**
     * Check if orders need to be updated
     */
    private needsOrderUpdate(
        openOrders: any[],
        bidOffset: number,
        askOffset: number
    ): boolean {
        // Need exactly 2 orders (bid + ask)
        if (openOrders.length !== 2) {
            return true;
        }

        // Check if offsets match
        const bidOrder = openOrders.find(o => o.direction === 'long');
        const askOrder = openOrders.find(o => o.direction === 'short');

        if (!bidOrder || !askOrder) {
            return true;
        }

        // Check if offsets are close enough
        const bidDiff = Math.abs(bidOrder.oraclePriceOffset - bidOffset);
        const askDiff = Math.abs(askOrder.oraclePriceOffset - askOffset);

        return bidDiff > 1 || askDiff > 1;  // Allow 1 tick difference
    }

    /**
     * Risk management checks
     */
    private checkRiskLimits(): boolean {
        const state = this.getOverallState();

        // Check drawdown
        if (state.peakValue > 0) {
            const drawdown = (state.peakValue - state.currentValue) / state.peakValue;
            if (drawdown > this.config.maxDrawdown) {
                console.error(`[${this.name}] DRAWDOWN EXCEEDED: ${(drawdown * 100).toFixed(2)}%`);
                return false;
            }
        }

        return true;
    }

    /**
     * Helper functions
     */
    private async syncPositions(): Promise<void> {
        const user = this.driftClient.getUser();

        for (const marketIndex of this.config.markets) {
            const position = user.getPerpPosition(marketIndex);
            const state = this.marketStates.get(marketIndex);

            if (state && position) {
                state.position = position.baseAssetAmount;
                this.marketStates.set(marketIndex, state);
            }
        }
    }

    private async getOpenOrders(marketIndex: number): Promise<any[]> {
        const user = this.driftClient.getUserAccount();
        const orders: any[] = [];

        for (const order of user.orders) {
            if (order.marketIndex === marketIndex && !isVariant(order.status, 'init')) {
                orders.push(order);
            }
        }

        return orders;
    }

    private async cancelOrdersForMarket(marketIndex: number): Promise<void> {
        const orders = await this.getOpenOrders(marketIndex);

        for (const order of orders) {
            await this.driftClient.cancelOrder(order.orderId);
            console.log(`[${this.name}] Cancelled order ${order.orderId}`);
        }
    }

    private async cancelAllOrders(): Promise<void> {
        for (const marketIndex of this.config.markets) {
            await this.cancelOrdersForMarket(marketIndex);
        }
    }

    private isOracleStale(oracle: OracleData): boolean {
        const now = Math.floor(Date.now() / 1000);
        const lastUpdate = oracle.lastUpdatedTs.toNumber();
        return (now - lastUpdate) > this.config.oracleStalenessSeconds;
    }

    private getCollateralValue(): number {
        const user = this.driftClient.getUser();
        return user.getTotalCollateral().toNumber();
    }

    private getOverallState(): { peakValue: number; currentValue: number } {
        // Implement based on your tracking
        return {
            peakValue: 0,
            currentValue: 0,
        };
    }
}
```

---

# 3️⃣ HYBRID STRATEGY DESIGN

## Combining Delta-Neutral + DLOB MM

```typescript
// strategies/hybrid/hybrid-vault-manager.ts

import { DriftClient, SlotSubscriber } from '@drift-labs/sdk';
import { DeltaNeutralManager } from '../delta-neutral/delta-neutral-manager';
import { FloatingPerpMaker, DEFAULT_MM_CONFIG } from '../dlob-mm/floating-perp-maker';

export interface HybridConfig {
    // Capital allocation
    mmAllocationPercent: number;      // 0.7 = 70% to market making
    deltaNeutralAllocationPercent: number; // 0.3 = 30% to delta-neutral

    // Switching thresholds
    fundingRateHighThreshold: number; // 0.0002 = switch more to delta-neutral
    fundingRateLowThreshold: number;  // 0.00005 = switch more to MM

    // Risk
    maxTotalDrawdown: number;         // 0.05 = 5% total vault drawdown
}

export const DEFAULT_HYBRID_CONFIG: HybridConfig = {
    mmAllocationPercent: 0.7,
    deltaNeutralAllocationPercent: 0.3,
    fundingRateHighThreshold: 0.0002,
    fundingRateLowThreshold: 0.00005,
    maxTotalDrawdown: 0.05,
};

export class HybridVaultManager {
    private driftClient: DriftClient;
    private slotSubscriber: SlotSubscriber;
    private config: HybridConfig;

    private mmStrategy: FloatingPerpMaker;
    private deltaNeutralStrategy: DeltaNeutralManager;

    private totalEquity: number;
    private peakEquity: number;

    constructor(
        driftClient: DriftClient,
        slotSubscriber: SlotSubscriber,
        config: HybridConfig = DEFAULT_HYBRID_CONFIG
    ) {
        this.driftClient = driftClient;
        this.slotSubscriber = slotSubscriber;
        this.config = config;

        // Initialize strategies
        this.mmStrategy = new FloatingPerpMaker(driftClient, slotSubscriber, {
            ...DEFAULT_MM_CONFIG,
            maxPositionExposure: 0.05, // Lower for hybrid
        });

        this.deltaNeutralStrategy = new DeltaNeutralManager(driftClient, {
            marketIndex: 0,
            positionSizeUsd: 1000,
            rebalanceIntervalMs: 24 * 60 * 60 * 1000,
            rebalanceThreshold: 0.05,
        });
    }

    /**
     * Initialize the hybrid vault
     */
    async init(): Promise<void> {
        console.log('[HYBRID] Initializing...');

        await this.mmStrategy.init();
        // Delta neutral doesn't need init in this example

        this.totalEquity = await this.getTotalEquity();
        this.peakEquity = this.totalEquity;

        console.log(`[HYBRID] Total equity: $${this.totalEquity}`);
    }

    /**
     * Start both strategies
     */
    async start(): Promise<void> {
        console.log('[HYBRID] Starting strategies...');

        // Start MM strategy
        await this.mmStrategy.start(5000);

        // Start delta-neutral hourly check
        setInterval(async () => {
            await this.runHourlyHybridCheck();
        }, 60 * 60 * 1000); // 1 hour

        console.log('[HYBRID] Strategies started');
    }

    /**
     * Hourly check - reallocate based on funding rates
     */
    private async runHourlyHybridCheck(): Promise<void> {
        console.log('[HYBRID] Running hourly check...');

        // Get current funding rates
        const fundingRates = await this.getFundingRates();

        // Calculate average funding
        const avgFunding = this.calculateAverageFunding(fundingRates);

        console.log(`[HYBRID] Average funding: ${(avgFunding * 100).toFixed(4)}%`);

        // Adjust allocation based on funding
        const newAllocation = this.calculateOptimalAllocation(avgFunding);

        console.log(`[HYBRID] Optimal allocation: ${(newAllocation.mm * 100).toFixed(0)}% MM, ${(newAllocation.deltaNeutral * 100).toFixed(0)}% Delta-Neutral`);

        // Check drawdown
        if (!this.checkDrawdown()) {
            console.warn('[HYBRID] Drawdown limit reached, pausing');
            await this.pause();
            return;
        }

        // Run delta-neutral check
        await this.deltaNeutralStrategy.runHourlyCheck();
    }

    /**
     * Calculate optimal allocation based on funding
     */
    private calculateOptimalAllocation(fundingRate: number): {
        mm: number;
        deltaNeutral: number;
    } {
        const { fundingRateHighThreshold, fundingRateLowThreshold } = this.config;

        if (Math.abs(fundingRate) > fundingRateHighThreshold) {
            // High funding - favor delta-neutral
            return { mm: 0.4, deltaNeutral: 0.6 };
        } else if (Math.abs(fundingRate) < fundingRateLowThreshold) {
            // Low funding - favor market making
            return { mm: 0.9, deltaNeutral: 0.1 };
        } else {
            // Normal - use default allocation
            return {
                mm: this.config.mmAllocationPercent,
                deltaNeutral: this.config.deltaNeutralAllocationPercent,
            };
        }
    }

    /**
     * Check total drawdown
     */
    private checkDrawdown(): boolean {
        this.totalEquity = this.getTotalEquitySync();
        this.peakEquity = Math.max(this.peakEquity, this.totalEquity);

        const drawdown = (this.peakEquity - this.totalEquity) / this.peakEquity;

        return drawdown < this.config.maxTotalDrawdown;
    }

    /**
     * Pause both strategies
     */
    private async pause(): Promise<void> {
        console.log('[HYBRID] Pausing all strategies');
        await this.mmStrategy.stop();
        // Stop delta-neutral
    }

    /**
     * Helper functions
     */
    private async getTotalEquity(): Promise<number> {
        const user = this.driftClient.getUser();
        return user.getTotalCollateral().toNumber();
    }

    private getTotalEquitySync(): number {
        const user = this.driftClient.getUser();
        return user.getTotalCollateral().toNumber();
    }

    private async getFundingRates(): Promise<Map<number, number>> {
        const rates = new Map<number, number>();

        for (const marketIndex of [0, 1]) { // SOL, ETH
            const market = this.driftClient.getPerpMarketAccount(marketIndex);
            const oracle = this.driftClient.getOracleDataForPerpMarket(marketIndex);

            const markPrice = market.amm.markPrice;
            const indexPrice = oracle.price;
            const rate = markPrice.sub(indexPrice).toNumber() / indexPrice.toNumber();

            rates.set(marketIndex, rate);
        }

        return rates;
    }

    private calculateAverageFunding(rates: Map<number, number>): number {
        let sum = 0;
        let count = 0;

        for (const rate of rates.values()) {
            sum += Math.abs(rate);
            count++;
        }

        return count > 0 ? sum / count : 0;
    }
}
```

---

# 4️⃣ CROSS-VENUE ARBITRAGE (BINANCE + DRIFT)

## Implementation for Higher Yield

```typescript
// strategies/cross-venue/cross-venue-arb.ts

import { DriftClient, PositionDirection, OrderType, BN } from '@drift-labs/sdk';
import Binance from 'binance-api-node';

export interface CrossVenueConfig {
    // Binance API
    binanceApiKey: string;
    binanceApiSecret: string;

    // Drift config
    driftMarketIndex: number;
    binanceSymbol: string;  // e.g., 'SOLUSDT'

    // Position size
    positionSizeUsd: number;

    // Arbitrage thresholds
    minFundingDiff: number;     // Minimum funding difference to trade
    minPriceDiff: number;       // Minimum price difference for arb

    // Risk
    maxPositionSize: number;
    maxDrawdown: number;
}

export class CrossVenueArbitrage {
    private driftClient: DriftClient;
    private binanceClient: Binance;
    private config: CrossVenueConfig;

    private driftPosition: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
    private binancePosition: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

    constructor(
        driftClient: DriftClient,
        config: CrossVenueConfig
    ) {
        this.driftClient = driftClient;
        this.config = config;

        this.binanceClient = Binance({
            apiKey: config.binanceApiKey,
            apiSecret: config.binanceApiSecret,
        });
    }

    /**
     * Main arbitrage loop
     */
    async runArbitrageCheck(): Promise<{
        action: string;
        details: string;
    }> {
        console.log('[CROSS-VENUE] Checking arbitrage opportunities...');

        // Get funding rates from both venues
        const driftFunding = await this.getDriftFundingRate();
        const binanceFunding = await this.getBinanceFundingRate();

        console.log(`  Drift funding: ${(driftFunding * 100).toFixed(4)}%`);
        console.log(`  Binance funding: ${(binanceFunding * 100).toFixed(4)}%`);

        // Calculate spread
        const fundingDiff = driftFunding - binanceFunding;
        console.log(`  Funding diff: ${(fundingDiff * 100).toFixed(4)}%`);

        // Check for arbitrage opportunity
        if (Math.abs(fundingDiff) > this.config.minFundingDiff) {
            if (fundingDiff > 0) {
                // Drift pays more for shorts
                // Short on Drift, Long on Binance
                return await this.executeArbitrage('SHORT_DRIFT', driftFunding, binanceFunding);
            } else {
                // Binance pays more for shorts
                // Short on Binance, Long on Drift
                return await this.executeArbitrage('SHORT_BINANCE', driftFunding, binanceFunding);
            }
        }

        // Check for price arbitrage
        const priceArb = await this.checkPriceArbitrage();
        if (priceArb) {
            return priceArb;
        }

        return { action: 'HOLD', details: 'No arbitrage opportunity' };
    }

    /**
     * Execute the arbitrage
     */
    private async executeArbitrage(
        direction: 'SHORT_DRIFT' | 'SHORT_BINANCE',
        driftFunding: number,
        binanceFunding: number
    ): Promise<{ action: string; details: string }> {
        console.log(`[CROSS-VENUE] Executing: ${direction}`);

        const size = this.config.positionSizeUsd;

        try {
            if (direction === 'SHORT_DRIFT') {
                // Short on Drift (collect positive funding)
                await this.shortOnDrift(size);

                // Long on Binance (hedge)
                await this.longOnBinance(size);

                this.driftPosition = 'SHORT';
                this.binancePosition = 'LONG';

            } else {
                // Short on Binance (collect positive funding)
                await this.shortOnBinance(size);

                // Long on Drift (hedge)
                await this.longOnDrift(size);

                this.driftPosition = 'LONG';
                this.binancePosition = 'SHORT';
            }

            return {
                action: 'ARBITRAGE_EXECUTED',
                details: `${direction}: Drift ${(driftFunding * 100).toFixed(2)}%, Binance ${(binanceFunding * 100).toFixed(2)}%`,
            };

        } catch (error) {
            console.error('[CROSS-VENUE] Error executing arbitrage:', error);
            return { action: 'ERROR', details: error.message };
        }
    }

    /**
     * Check for price arbitrage opportunities
     */
    private async checkPriceArbitrage(): Promise<{ action: string; details: string } | null> {
        // Get prices from both venues
        const driftPrice = await this.getDriftPrice();
        const binancePrice = await this.getBinancePrice();

        const priceDiff = (driftPrice - binancePrice) / binancePrice;

        console.log(`[CROSS-VENUE] Price diff: ${(priceDiff * 100).toFixed(4)}%`);

        if (Math.abs(priceDiff) > this.config.minPriceDiff) {
            // Execute price arb
            // This is a simplified version - you'd need more sophisticated logic
            return {
                action: 'PRICE_ARB',
                details: `Price diff: ${(priceDiff * 100).toFixed(4)}%`,
            };
        }

        return null;
    }

    /**
     * Close all positions
     */
    async closeAllPositions(): Promise<void> {
        console.log('[CROSS-VENUE] Closing all positions...');

        // Close Drift position
        if (this.driftPosition !== 'NONE') {
            await this.closeDriftPosition();
            this.driftPosition = 'NONE';
        }

        // Close Binance position
        if (this.binancePosition !== 'NONE') {
            await this.closeBinancePosition();
            this.binancePosition = 'NONE';
        }
    }

    /**
     * Helper functions for Drift
     */
    private async getDriftFundingRate(): Promise<number> {
        const market = this.driftClient.getPerpMarketAccount(this.config.driftMarketIndex);
        const oracle = this.driftClient.getOracleDataForPerpMarket(this.config.driftMarketIndex);

        const markPrice = market.amm.markPrice;
        const indexPrice = oracle.price;

        return markPrice.sub(indexPrice).toNumber() / indexPrice.toNumber();
    }

    private async getDriftPrice(): Promise<number> {
        const market = this.driftClient.getPerpMarketAccount(this.config.driftMarketIndex);
        return market.amm.markPrice.toNumber();
    }

    private async shortOnDrift(sizeUsd: number): Promise<void> {
        const size = new BN(sizeUsd * 1e6);

        await this.driftClient.placePerpOrder({
            marketIndex: this.config.driftMarketIndex,
            orderType: OrderType.MARKET,
            direction: PositionDirection.SHORT,
            baseAssetAmount: this.usdToBaseAsset(size),
        });
    }

    private async longOnDrift(sizeUsd: number): Promise<void> {
        const size = new BN(sizeUsd * 1e6);

        await this.driftClient.placePerpOrder({
            marketIndex: this.config.driftMarketIndex,
            orderType: OrderType.MARKET,
            direction: PositionDirection.LONG,
            baseAssetAmount: this.usdToBaseAsset(size),
        });
    }

    private async closeDriftPosition(): Promise<void> {
        const user = this.driftClient.getUser();
        const position = user.getPerpPosition(this.config.driftMarketIndex);

        if (position && !position.baseAssetAmount.isZero()) {
            const direction = position.baseAssetAmount.gt(new BN(0))
                ? PositionDirection.SHORT
                : PositionDirection.LONG;

            await this.driftClient.placePerpOrder({
                marketIndex: this.config.driftMarketIndex,
                orderType: OrderType.MARKET,
                direction,
                baseAssetAmount: position.baseAssetAmount.abs(),
            });
        }
    }

    /**
     * Helper functions for Binance
     */
    private async getBinanceFundingRate(): Promise<number> {
        const funding = await this.binanceClient.futuresFundingRate({
            symbol: this.config.binanceSymbol,
        });

        return parseFloat(funding[0].fundingRate);
    }

    private async getBinancePrice(): Promise<number> {
        const ticker = await this.binanceClient.futuresMarkPrice({
            symbol: this.config.binanceSymbol,
        });

        return parseFloat(ticker.markPrice);
    }

    private async shortOnBinance(sizeUsd: number): Promise<void> {
        const quantity = this.usdToBinanceQuantity(sizeUsd);

        await this.binanceClient.futuresOrder({
            symbol: this.config.binanceSymbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity.toString(),
        });
    }

    private async longOnBinance(sizeUsd: number): Promise<void> {
        const quantity = this.usdToBinanceQuantity(sizeUsd);

        await this.binanceClient.futuresOrder({
            symbol: this.config.binanceSymbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: quantity.toString(),
        });
    }

    private async closeBinancePosition(): Promise<void> {
        const position = await this.binanceClient.futuresPositionRisk({
            symbol: this.config.binanceSymbol,
        });

        const pos = position[0];
        const posAmt = parseFloat(pos.positionAmt);

        if (posAmt !== 0) {
            const side = posAmt > 0 ? 'SELL' : 'BUY';
            const quantity = Math.abs(posAmt).toString();

            await this.binanceClient.futuresOrder({
                symbol: this.config.binanceSymbol,
                side,
                type: 'MARKET',
                quantity,
            });
        }
    }

    /**
     * Utility functions
     */
    private usdToBaseAsset(usd: BN): BN {
        // Convert USD to base asset amount
        // This is simplified - you'd use actual price
        return usd.divn(100);
    }

    private usdToBinanceQuantity(usd: number): number {
        // Convert USD to Binance quantity
        // This is simplified - you'd use actual price and precision
        return usd / 100;
    }
}
```

---

## Cross-Venue Configuration Example

```typescript
// config/cross-venue-config.ts

export const CROSS_VENUE_CONFIG = {
    // Binance credentials
    binanceApiKey: process.env.BINANCE_API_KEY!,
    binanceApiSecret: process.env.BINANCE_API_SECRET!,

    // Drift market
    driftMarketIndex: 0,  // SOL-PERP
    binanceSymbol: 'SOLUSDT',

    // Position sizing
    positionSizeUsd: 5000,

    // Thresholds
    minFundingDiff: 0.0001,  // 1 bp difference
    minPriceDiff: 0.001,     // 0.1% price difference

    // Risk
    maxPositionSize: 20000,
    maxDrawdown: 0.05,
};
```

---

# 📊 COMPARISON TABLE

| Strategy | APY Potential | Complexity | Capital Efficiency | Risk Level |
|----------|--------------|------------|-------------------|------------|
| **Delta-Neutral (Fixed)** | 5-15% | Medium | High | Low |
| **DLOB Market Making** | 15-50% | Medium | Medium | Medium |
| **Hybrid** | 15-35% | High | High | Low-Medium |
| **Cross-Venue** | 20-50% | High | High | Medium |

---

# 🚀 DEPLOYMENT CHECKLIST

## Before Mainnet

- [ ] Test on devnet first
- [ ] Start with small capital ($100-500)
- [ ] Set up monitoring (Prometheus/Grafana)
- [ ] Configure alerts (Discord/Telegram)
- [ ] Test circuit breakers trigger correctly
- [ ] Verify oracle staleness checks work
- [ ] Test emergency stop functionality

## Monitoring Setup

```typescript
// monitoring/metrics.ts

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export class StrategyMetrics {
    private registry: Registry;

    // Counters
    public flipsTotal: Counter;
    public ordersPlaced: Counter;
    public ordersFilled: Counter;
    public errorsTotal: Counter;

    // Gauges
    public currentPnL: Gauge;
    public currentPosition: Gauge;
    public fundingRate: Gauge;

    // Histograms
    public executionLatency: Histogram;

    constructor() {
        this.registry = new Registry();

        this.flipsTotal = new Counter({
            name: 'strategy_flips_total',
            help: 'Total number of position flips',
            registers: [this.registry],
        });

        this.ordersPlaced = new Counter({
            name: 'strategy_orders_placed_total',
            help: 'Total orders placed',
            labelNames: ['market', 'side'],
            registers: [this.registry],
        });

        this.ordersFilled = new Counter({
            name: 'strategy_orders_filled_total',
            help: 'Total orders filled',
            labelNames: ['market', 'side'],
            registers: [this.registry],
        });

        this.errorsTotal = new Counter({
            name: 'strategy_errors_total',
            help: 'Total errors',
            labelNames: ['type'],
            registers: [this.registry],
        });

        this.currentPnL = new Gauge({
            name: 'strategy_current_pnl',
            help: 'Current P&L in USD',
            registers: [this.registry],
        });

        this.currentPosition = new Gauge({
            name: 'strategy_current_position',
            help: 'Current position size',
            labelNames: ['market'],
            registers: [this.registry],
        });

        this.fundingRate = new Gauge({
            name: 'strategy_funding_rate',
            help: 'Current funding rate',
            labelNames: ['market'],
            registers: [this.registry],
        });

        this.executionLatency = new Histogram({
            name: 'strategy_execution_latency_seconds',
            help: 'Order execution latency',
            buckets: [0.1, 0.5, 1, 2, 5, 10],
            registers: [this.registry],
        });
    }

    getRegistry(): Registry {
        return this.registry;
    }
}
```

---

# 📝 SUBMISSION TEMPLATE

## Strategy Documentation for Hackathon

```markdown
# [Your Strategy Name] - Strategy Documentation

## Executive Summary
[2-3 sentences describing your strategy]

## Strategy Thesis
[Why this strategy works, what edge it captures]

## Implementation Details
[How it works technically]

## Risk Management
- Position limits: X% of collateral
- Drawdown limit: X%
- Circuit breaker: X hours between flips
- Oracle validation: X seconds staleness threshold

## Performance Metrics
- Backtested APY: X%
- Live test PnL: $X over Y days
- Max drawdown: X%
- Sharpe ratio: X.XX

## On-Chain Verification
- Vault address: [address]
- Bot wallet: [address]
- Activity verified on Solscan: [link]

## Code Repository
- GitHub: [link]
- Key files: [list]
```

---

Good luck with your hackathon submission! 🏆
