import { TelegramAlerter } from "../alerts/telegram";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("TelegramAlerter", () => {
  let alerter: TelegramAlerter;

  beforeEach(() => {
    // No env vars = disabled
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    alerter = new TelegramAlerter();
  });

  it("is disabled when env vars are not set", () => {
    // Should not throw when sending alerts while disabled
    expect(async () => {
      await alerter.alert("info", "test message");
    }).not.toThrow();
  });

  it("handles cycleSummary without errors when disabled", async () => {
    await alerter.cycleSummary({
      cycle: 1,
      regime: "neutral",
      pnl: "0.0050",
      apy: "12.5%",
      health: "5.0000",
      positions: 3,
      funding: "$0.0050",
    });
    // No error thrown = success
  });

  it("handles emergencyAlert without errors when disabled", async () => {
    await alerter.emergencyAlert("Health ratio critical");
    // No error thrown
  });

  it("handles riskAlert without errors when disabled", async () => {
    await alerter.riskAlert([
      "Health ratio 1.05 below floor 1.10",
      "Drawdown 4.5% exceeds max 3.0%",
    ]);
    // No error thrown
  });

  it("flushes empty queue without errors", async () => {
    await alerter.flush();
    // No error thrown
  });
});
