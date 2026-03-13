import Decimal from "decimal.js";
import { OracleGuard } from "../risk/oracle-guard";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("OracleGuard", () => {
  let guard: OracleGuard;

  beforeEach(() => {
    guard = new OracleGuard(new Decimal(50)); // 50 bps max
  });

  it("passes when spread is within bounds", () => {
    const result = guard.check(
      "SOL",
      new Decimal("185.00"),
      new Decimal("185.05") // 2.7 bps spread
    );
    expect(result.safe).toBe(true);
    expect(result.spreadPct.lt(new Decimal("0.05"))).toBe(true);
  });

  it("fails when spread exceeds max", () => {
    const result = guard.check(
      "SOL",
      new Decimal("185.00"),
      new Decimal("187.00") // ~108 bps spread
    );
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("exceeds max");
  });

  it("fails on zero oracle price", () => {
    const result = guard.check(
      "BTC",
      new Decimal(0),
      new Decimal("98000")
    );
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Zero price");
  });

  it("fails on zero mark price", () => {
    const result = guard.check(
      "ETH",
      new Decimal("3400"),
      new Decimal(0)
    );
    expect(result.safe).toBe(false);
  });

  it("batch checks all assets", () => {
    const { allSafe, checks } = guard.checkAll([
      {
        asset: "SOL",
        oraclePrice: new Decimal("185.00"),
        markPrice: new Decimal("185.02"),
      },
      {
        asset: "BTC",
        oraclePrice: new Decimal("98000"),
        markPrice: new Decimal("98010"),
      },
    ]);
    expect(allSafe).toBe(true);
    expect(checks).toHaveLength(2);
  });

  it("batch fails if any asset is unsafe", () => {
    const { allSafe } = guard.checkAll([
      {
        asset: "SOL",
        oraclePrice: new Decimal("185.00"),
        markPrice: new Decimal("185.02"),
      },
      {
        asset: "BTC",
        oraclePrice: new Decimal("98000"),
        markPrice: new Decimal("100000"), // huge spread
      },
    ]);
    expect(allSafe).toBe(false);
  });

  it("handles negative spread (mark < oracle)", () => {
    const result = guard.check(
      "SOL",
      new Decimal("185.00"),
      new Decimal("184.95") // negative 2.7 bps
    );
    // Should still pass — absolute spread is within bounds
    expect(result.safe).toBe(true);
  });
});
