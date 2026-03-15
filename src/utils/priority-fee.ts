import { config } from "../config";
import { logger } from "./logger";

interface HeliusPriorityFeeEstimateResponse {
  result?: {
    priorityFeeEstimate?: number;
    priorityFeeLevels?: Record<string, number>;
  };
}

export async function fetchHeliusPriorityFeeEstimate(
  accountKeys: string[],
  lookbackSlots = 50
): Promise<number | null> {
  if (!config.heliusRpcUrl) {
    return null;
  }

  try {
    const response = await fetch(config.heliusRpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ranger-priority-fee",
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys,
            options: {
              includeAllPriorityFeeLevels: true,
              lookbackSlots,
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Helius RPC ${response.status}`);
    }

    const data =
      (await response.json()) as HeliusPriorityFeeEstimateResponse;
    const levels = data.result?.priorityFeeLevels || {};
    return (
      levels.veryHigh ??
      levels.high ??
      data.result?.priorityFeeEstimate ??
      null
    );
  } catch (error) {
    logger.warn("Failed to fetch Helius priority fee estimate", { error });
    return null;
  }
}
