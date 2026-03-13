/**
 * Telegram alerting for production monitoring.
 *
 * Sends critical alerts (emergency unwind, risk violations, cycle summaries)
 * to a Telegram chat via the Bot API.
 *
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable.
 */
import https from "https";
import { logger } from "../utils/logger";

export type AlertLevel = "info" | "warn" | "critical";

export class TelegramAlerter {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  /** Rate limit: max 1 message per 10 seconds to avoid Telegram API limits */
  private lastSentAt = 0;
  private readonly MIN_INTERVAL_MS = 10_000;
  /** Queue messages when rate-limited */
  private queue: string[] = [];

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    this.chatId = process.env.TELEGRAM_CHAT_ID || "";
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      logger.info("Telegram alerts disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)");
    }
  }

  async alert(level: AlertLevel, message: string): Promise<void> {
    if (!this.enabled) return;

    const emoji =
      level === "critical" ? "\u{1F6A8}" :
      level === "warn" ? "\u{26A0}\u{FE0F}" :
      "\u{2139}\u{FE0F}";
    const text = `${emoji} *${level.toUpperCase()}*\n${this.escapeMarkdown(message)}`;

    // Rate limiting
    const now = Date.now();
    if (now - this.lastSentAt < this.MIN_INTERVAL_MS) {
      this.queue.push(text);
      return;
    }

    // Send queued messages first
    if (this.queue.length > 0) {
      const batch = this.queue.splice(0, 5).join("\n\n---\n\n");
      await this.send(batch);
    }

    await this.send(text);
    this.lastSentAt = Date.now();
  }

  /** Send cycle summary */
  async cycleSummary(data: {
    cycle: number;
    regime: string;
    pnl: string;
    apy: string;
    health: string;
    positions: number;
    funding: string;
  }): Promise<void> {
    await this.alert(
      "info",
      [
        `Cycle #${data.cycle} complete`,
        `Regime: ${data.regime}`,
        `PnL: ${data.pnl} | APY: ${data.apy}`,
        `Health: ${data.health} | Positions: ${data.positions}`,
        `Funding collected: ${data.funding}`,
      ].join("\n")
    );
  }

  /** Send emergency unwind alert */
  async emergencyAlert(reason: string): Promise<void> {
    await this.alert(
      "critical",
      `EMERGENCY UNWIND TRIGGERED\nReason: ${reason}`
    );
  }

  /** Send risk violation alert */
  async riskAlert(violations: string[]): Promise<void> {
    await this.alert(
      "warn",
      `Risk violations:\n${violations.map((v) => `• ${v}`).join("\n")}`
    );
  }

  /** Flush any queued messages */
  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0).join("\n\n---\n\n");
    await this.send(batch);
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
  }

  private send(text: string): Promise<void> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "MarkdownV2",
      });

      const options = {
        hostname: "api.telegram.org",
        path: `/bot${this.botToken}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            logger.warn("Telegram send failed", {
              status: res.statusCode,
              body: data.slice(0, 200),
            });
          }
          resolve();
        });
      });

      req.on("error", (err) => {
        logger.warn("Telegram request error", { error: err.message });
        resolve(); // Don't throw — alerts are non-critical
      });

      req.write(payload);
      req.end();
    });
  }
}
