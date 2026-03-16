import { BN } from "@drift-labs/sdk";
import Decimal from "decimal.js";

export interface ExecutionPricingInput {
  side: "long" | "short";
  oraclePrice: Decimal;
  fallbackSlippageBps: number;
  quotedPrice?: Decimal;
  oracleConfidenceBps?: number;
  oracleSpreadBps?: number;
  maxSlippageBps?: number;
}

export interface ExecutionPricingPlan {
  limitPrice: Decimal;
  slippageBps: number;
  quotedPrice?: Decimal;
  oracleSpreadBps?: number;
  oracleConfidenceBps?: number;
}

const PROTOCOL_V2_AUCTION_BUFFER_BPS = 50;
const DEFAULT_MAX_SLIPPAGE_BPS = 250;

export function deriveExecutionPricingPlan(
  input: ExecutionPricingInput
): ExecutionPricingPlan {
  const maxSlippageBps = input.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;

  if (input.oraclePrice.lte(0)) {
    throw new Error(`Invalid oracle price: ${input.oraclePrice.toFixed()}`);
  }

  let oracleSpreadBps: number | undefined;
  let oracleConfidenceBps: number | undefined;
  let slippageBps = input.fallbackSlippageBps;

  if (input.quotedPrice && input.quotedPrice.gt(0)) {
    oracleSpreadBps = Math.ceil(
      input.quotedPrice
        .sub(input.oraclePrice)
        .div(input.oraclePrice)
        .abs()
        .mul(10_000)
        .toNumber()
    );

    slippageBps = Math.min(
      maxSlippageBps,
      Math.max(
        input.fallbackSlippageBps,
        oracleSpreadBps + PROTOCOL_V2_AUCTION_BUFFER_BPS
      )
    );
  }

  if (input.oracleSpreadBps !== undefined) {
    oracleSpreadBps = input.oracleSpreadBps;
    slippageBps = Math.min(
      maxSlippageBps,
      Math.max(slippageBps, oracleSpreadBps + PROTOCOL_V2_AUCTION_BUFFER_BPS)
    );
  }

  if (input.oracleConfidenceBps !== undefined) {
    oracleConfidenceBps = input.oracleConfidenceBps;
    slippageBps = Math.min(
      maxSlippageBps,
      Math.max(
        slippageBps,
        oracleConfidenceBps + PROTOCOL_V2_AUCTION_BUFFER_BPS
      )
    );
  }

  const oracleAdjustedPrice =
    input.side === "long"
      ? input.oraclePrice.mul(10_000 + slippageBps).div(10_000)
      : input.oraclePrice.mul(10_000 - slippageBps).div(10_000);

  const limitPrice = input.quotedPrice
    ? input.side === "long"
      ? Decimal.max(oracleAdjustedPrice, input.quotedPrice)
      : Decimal.min(oracleAdjustedPrice, input.quotedPrice)
    : oracleAdjustedPrice;

  return {
    limitPrice,
    slippageBps,
    quotedPrice: input.quotedPrice,
    oracleSpreadBps,
    oracleConfidenceBps,
  };
}

export function decimalPriceToBN(price: Decimal): BN {
  return new BN(price.mul(1e6).toFixed(0));
}
