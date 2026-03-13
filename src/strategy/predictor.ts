/**
 * Funding rate predictor — the AI brain of the strategy.
 *
 * Uses multiple signals to predict future funding rates:
 * 1. Exponential Moving Average (EMA) of historical rates
 * 2. Momentum scoring (rate of change)
 * 3. Mean reversion detection (extreme rates tend to revert)
 * 4. Cross-asset correlation (funding tends to move together)
 * 5. Long/short imbalance as leading indicator
 *
 * The predictor outputs a confidence-weighted forecast that the
 * strategy engine uses for position sizing and direction selection.
 */
import Decimal from "decimal.js";
import { FundingRate } from "./types";
import { logger } from "../utils/logger";

export interface FundingPrediction {
  asset: string;
  /** Predicted annualized funding rate */
  predictedRate: Decimal;
  /** Confidence in the prediction (0-1) */
  confidence: Decimal;
  /** Predicted direction: positive = shorts collect, negative = longs collect */
  direction: "positive" | "negative";
  /** Strength of the signal */
  signalStrength: "strong" | "moderate" | "weak";
  /** Contributing signals for explainability */
  signals: {
    emaSignal: Decimal;
    momentumSignal: Decimal;
    meanReversionSignal: Decimal;
    crossAssetSignal: Decimal;
  };
}

export class FundingPredictor {
  /** EMA decay factor (higher = more weight on recent data) */
  private readonly emaAlpha: number;
  /** Historical rates per asset for time-series analysis */
  private history: Map<string, Decimal[]> = new Map();
  /** Maximum history length to retain */
  private readonly maxHistory: number;

  constructor(emaAlpha: number = 0.3, maxHistory: number = 168) {
    this.emaAlpha = emaAlpha;
    this.maxHistory = maxHistory;
  }

  /**
   * Update the predictor with new funding rate observations.
   * Call this every cycle with fresh rates.
   */
  update(rates: FundingRate[]): void {
    for (const rate of rates) {
      const history = this.history.get(rate.asset) || [];
      history.push(rate.annualizedRate);
      // Keep only recent history
      if (history.length > this.maxHistory) {
        history.splice(0, history.length - this.maxHistory);
      }
      this.history.set(rate.asset, history);
    }
  }

  /**
   * Predict future funding rate for an asset.
   * Combines multiple signals with confidence weighting.
   */
  predict(asset: string): FundingPrediction {
    const history = this.history.get(asset) || [];

    // Default prediction when insufficient data
    if (history.length < 3) {
      return {
        asset,
        predictedRate: history.length > 0 ? history[history.length - 1] : new Decimal(0),
        confidence: new Decimal("0.3"),
        direction: "positive",
        signalStrength: "weak",
        signals: {
          emaSignal: new Decimal(0),
          momentumSignal: new Decimal(0),
          meanReversionSignal: new Decimal(0),
          crossAssetSignal: new Decimal(0),
        },
      };
    }

    // 1. EMA-based trend prediction
    const emaSignal = this.calculateEMA(history);

    // 2. Momentum (rate of change over recent periods)
    const momentumSignal = this.calculateMomentum(history);

    // 3. Mean reversion signal (extreme rates tend to revert)
    const meanReversionSignal = this.calculateMeanReversion(history);

    // 4. Cross-asset correlation (funding moves together across markets)
    const crossAssetSignal = this.calculateCrossAssetSignal(asset);

    // Weighted combination of signals
    const weights = {
      ema: new Decimal("0.40"),       // EMA is strongest predictor
      momentum: new Decimal("0.25"),   // Momentum captures trends
      meanReversion: new Decimal("0.20"), // Reversion captures extremes
      crossAsset: new Decimal("0.15"), // Cross-asset adds diversification
    };

    const predictedRate = emaSignal.mul(weights.ema)
      .add(momentumSignal.mul(weights.momentum))
      .add(meanReversionSignal.mul(weights.meanReversion))
      .add(crossAssetSignal.mul(weights.crossAsset));

    // Calculate confidence based on signal agreement
    const signalAgreement = this.calculateSignalAgreement(
      emaSignal, momentumSignal, meanReversionSignal, crossAssetSignal
    );

    // Data quality factor: more data = higher confidence
    const dataQuality = new Decimal(Math.min(1, history.length / 48));
    const confidence = Decimal.min(
      new Decimal("0.95"),
      signalAgreement.mul(dataQuality)
    );

    // Direction and strength
    const direction: "positive" | "negative" =
      predictedRate.gte(0) ? "positive" : "negative";

    const absRate = predictedRate.abs();
    const signalStrength: "strong" | "moderate" | "weak" =
      absRate.gt(new Decimal("0.15")) ? "strong" :
      absRate.gt(new Decimal("0.08")) ? "moderate" : "weak";

    logger.info(`Funding prediction for ${asset}`, {
      predicted: `${predictedRate.mul(100).toFixed(2)}%`,
      confidence: `${confidence.mul(100).toFixed(0)}%`,
      direction,
      strength: signalStrength,
      ema: emaSignal.toFixed(4),
      momentum: momentumSignal.toFixed(4),
      meanReversion: meanReversionSignal.toFixed(4),
      crossAsset: crossAssetSignal.toFixed(4),
      historyLength: history.length.toString(),
    });

    return {
      asset,
      predictedRate,
      confidence,
      direction,
      signalStrength,
      signals: {
        emaSignal,
        momentumSignal,
        meanReversionSignal,
        crossAssetSignal,
      },
    };
  }

  /**
   * Predict all assets and return sorted by confidence × absolute rate.
   */
  predictAll(assets: string[]): FundingPrediction[] {
    return assets
      .map((asset) => this.predict(asset))
      .sort((a, b) =>
        b.confidence.mul(b.predictedRate.abs())
          .minus(a.confidence.mul(a.predictedRate.abs()))
          .toNumber()
      );
  }

  /**
   * Exponential Moving Average — smooths noise, tracks trend.
   * More recent values get exponentially higher weight.
   */
  private calculateEMA(history: Decimal[]): Decimal {
    if (history.length === 0) return new Decimal(0);

    let ema = history[0];
    const alpha = new Decimal(this.emaAlpha);
    const oneMinusAlpha = new Decimal(1).sub(alpha);

    for (let i = 1; i < history.length; i++) {
      ema = alpha.mul(history[i]).add(oneMinusAlpha.mul(ema));
    }

    return ema;
  }

  /**
   * Momentum — rate of change over recent periods.
   * Rising funding = positive momentum = likely to continue.
   *
   * Uses weighted slope of last N observations.
   */
  private calculateMomentum(history: Decimal[]): Decimal {
    const windowSize = Math.min(12, history.length);
    if (windowSize < 3) return new Decimal(0);

    const recent = history.slice(-windowSize);

    // Linear regression slope
    let sumX = 0, sumY = new Decimal(0);
    let sumXY = new Decimal(0), sumX2 = 0;

    for (let i = 0; i < recent.length; i++) {
      sumX += i;
      sumY = sumY.add(recent[i]);
      sumXY = sumXY.add(recent[i].mul(i));
      sumX2 += i * i;
    }

    const n = recent.length;
    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return new Decimal(0);

    const slope = sumXY.mul(n).sub(sumY.mul(sumX)).div(denominator);

    // Project forward: current value + slope * 8 hours
    const currentRate = recent[recent.length - 1];
    return currentRate.add(slope.mul(8));
  }

  /**
   * Mean reversion — extreme funding rates tend to revert to the mean.
   *
   * When current rate is >2 standard deviations from mean,
   * predict movement back toward the mean.
   */
  private calculateMeanReversion(history: Decimal[]): Decimal {
    if (history.length < 10) {
      return history.length > 0 ? history[history.length - 1] : new Decimal(0);
    }

    // Calculate mean
    const mean = history
      .reduce((sum, v) => sum.add(v), new Decimal(0))
      .div(history.length);

    // Calculate standard deviation
    const variance = history
      .reduce((sum, v) => sum.add(v.sub(mean).pow(2)), new Decimal(0))
      .div(history.length);
    const stdDev = variance.sqrt();

    if (stdDev.isZero()) return mean;

    const currentRate = history[history.length - 1];
    const zScore = currentRate.sub(mean).div(stdDev);

    // If z-score > 2 or < -2, predict reversion toward mean
    // Otherwise, predict continuation
    if (zScore.abs().gt(2)) {
      // Strong reversion: pull 50% toward mean
      return currentRate.add(mean.sub(currentRate).mul("0.5"));
    } else if (zScore.abs().gt(1)) {
      // Mild reversion: pull 20% toward mean
      return currentRate.add(mean.sub(currentRate).mul("0.2"));
    }

    // No reversion — just return current
    return currentRate;
  }

  /**
   * Cross-asset correlation signal.
   * Funding rates across crypto assets are correlated because
   * market-wide leverage affects all perp markets similarly.
   *
   * If SOL and BTC funding are strongly positive, ETH is likely
   * to follow (and vice versa).
   */
  private calculateCrossAssetSignal(targetAsset: string): Decimal {
    const otherAssets: Decimal[] = [];

    for (const [asset, history] of this.history.entries()) {
      if (asset === targetAsset || history.length === 0) continue;
      // Use most recent rate from other assets
      otherAssets.push(history[history.length - 1]);
    }

    if (otherAssets.length === 0) {
      const targetHistory = this.history.get(targetAsset) || [];
      return targetHistory.length > 0 ? targetHistory[targetHistory.length - 1] : new Decimal(0);
    }

    // Average of other assets' rates — this is the cross-asset signal
    const crossAvg = otherAssets
      .reduce((sum, v) => sum.add(v), new Decimal(0))
      .div(otherAssets.length);

    // Blend with target's own rate (70/30 own/cross)
    const targetHistory = this.history.get(targetAsset) || [];
    const ownRate = targetHistory.length > 0 ? targetHistory[targetHistory.length - 1] : new Decimal(0);

    return ownRate.mul("0.7").add(crossAvg.mul("0.3"));
  }

  /**
   * Calculate signal agreement — when signals agree, confidence is higher.
   * Returns 0-1 score.
   */
  private calculateSignalAgreement(
    ema: Decimal,
    momentum: Decimal,
    meanReversion: Decimal,
    crossAsset: Decimal
  ): Decimal {
    const signals = [ema, momentum, meanReversion, crossAsset];

    // Count how many signals agree on direction
    const positiveCount = signals.filter((s) => s.gte(0)).length;
    const allAgree = positiveCount === 0 || positiveCount === signals.length;

    if (allAgree) return new Decimal("0.85"); // Strong agreement

    const majorityAgree = positiveCount >= 3 || positiveCount <= 1;
    if (majorityAgree) return new Decimal("0.65"); // Majority agreement

    return new Decimal("0.45"); // Mixed signals
  }

  /**
   * Get the number of observations available for an asset.
   */
  getHistoryLength(asset: string): number {
    return (this.history.get(asset) || []).length;
  }

  /**
   * Get the internal history map (for state persistence).
   */
  getHistory(): Map<string, Decimal[]> {
    return this.history;
  }

  /**
   * Restore history from saved state.
   */
  restoreHistory(saved: Map<string, Decimal[]>): void {
    this.history = new Map(saved);
  }

  /**
   * Clear all historical data.
   */
  reset(): void {
    this.history.clear();
  }
}
