/**
 * OpenRouter API client — thin wrapper for LLM calls.
 *
 * Uses the OpenAI-compatible chat completions endpoint at OpenRouter.
 * Default model: Claude Sonnet 4 (fast, cheap, good at structured output).
 */
import { config } from "../config";
import { logger } from "../utils/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: {
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class OpenRouterClient {
  private apiKey: string;
  private defaultModel: string;
  private baseUrl = "https://openrouter.ai/api/v1";

  constructor(
    apiKey?: string,
    model: string = "anthropic/claude-sonnet-4"
  ) {
    this.apiKey = apiKey || config.openRouterApiKey;
    this.defaultModel = model;
    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY not set");
    }
  }

  /**
   * Send a chat completion request and return the text response.
   */
  async chat(
    messages: ChatMessage[],
    opts?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<string> {
    const model = opts?.model || this.defaultModel;
    const body = {
      model,
      messages,
      temperature: opts?.temperature ?? 0.3,
      max_tokens: opts?.maxTokens ?? 2048,
    };

    const startMs = Date.now();

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/ranger-vault",
        "X-Title": "Ranger Funding Harvester",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OpenRouterResponse;
    const content = data.choices?.[0]?.message?.content || "";
    const elapsed = Date.now() - startMs;

    logger.info("LLM call completed", {
      model,
      tokens: data.usage?.total_tokens,
      latencyMs: elapsed,
    });

    return content;
  }

  /**
   * Send a chat request and parse the response as JSON.
   * Extracts JSON from markdown code blocks if present.
   */
  async chatJSON<T>(
    messages: ChatMessage[],
    opts?: { model?: string; temperature?: number; maxTokens?: number }
  ): Promise<T> {
    const raw = await this.chat(messages, opts);

    // Extract JSON from ```json ... ``` blocks if present
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      logger.error("Failed to parse LLM JSON response", { raw });
      throw new Error(`LLM returned invalid JSON: ${jsonStr.slice(0, 200)}`);
    }
  }
}
