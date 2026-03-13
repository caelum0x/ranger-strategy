import Decimal from "decimal.js";
import { MonitorServer } from "../monitor/server";

// Silence logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("MonitorServer", () => {
  let server: MonitorServer;
  const port = 3999; // Use high port to avoid conflicts

  beforeEach(() => {
    server = new MonitorServer(port);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("starts and stops without errors", async () => {
    server.route("/test", () => ({ ok: true }));
    await server.start();
    await server.stop();
  });

  it("serves registered routes", async () => {
    server.route("/status", () => ({
      status: "running",
      cycle: 5,
    }));
    await server.start();

    const res = await fetch(`http://localhost:${port}/status`);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.status).toBe("running");
    expect(data.cycle).toBe(5);
  });

  it("returns 404 for unknown routes", async () => {
    await server.start();

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("handles async route handlers", async () => {
    server.route("/async", async () => {
      return { result: "async-ok" };
    });
    await server.start();

    const res = await fetch(`http://localhost:${port}/async`);
    const data = await res.json() as any;
    expect(data.result).toBe("async-ok");
  });

  it("returns 500 on handler error", async () => {
    server.route("/error", () => {
      throw new Error("test error");
    });
    await server.start();

    const res = await fetch(`http://localhost:${port}/error`);
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.message).toBe("test error");
  });

  it("sets CORS headers", async () => {
    server.route("/cors", () => ({ ok: true }));
    await server.start();

    const res = await fetch(`http://localhost:${port}/cors`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("MonitorServer.calculateHealthScore", () => {
  it("returns grade A for healthy vault", () => {
    const result = MonitorServer.calculateHealthScore({
      healthRatio: new Decimal("5.0"),
      drawdownPct: new Decimal("0.5"),
      deltaImbalance: new Decimal("0.01"),
      capitalUtilization: new Decimal("0.5"),
    });
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.grade).toBe("A");
  });

  it("returns grade F for critical vault", () => {
    const result = MonitorServer.calculateHealthScore({
      healthRatio: new Decimal("1.05"),
      drawdownPct: new Decimal("4.0"),
      deltaImbalance: new Decimal("0.10"),
      capitalUtilization: new Decimal("0.99"),
    });
    expect(result.score).toBeLessThan(40);
    expect(result.grade).toBe("F");
  });

  it("penalizes low health ratio", () => {
    const healthy = MonitorServer.calculateHealthScore({
      healthRatio: new Decimal("5.0"),
      drawdownPct: new Decimal("0"),
      deltaImbalance: new Decimal("0"),
      capitalUtilization: new Decimal("0.5"),
    });
    const unhealthy = MonitorServer.calculateHealthScore({
      healthRatio: new Decimal("1.3"),
      drawdownPct: new Decimal("0"),
      deltaImbalance: new Decimal("0"),
      capitalUtilization: new Decimal("0.5"),
    });
    expect(healthy.score).toBeGreaterThan(unhealthy.score);
  });

  it("penalizes high drawdown", () => {
    const low = MonitorServer.calculateHealthScore({
      healthRatio: new Decimal("5.0"),
      drawdownPct: new Decimal("0.5"),
      deltaImbalance: new Decimal("0"),
      capitalUtilization: new Decimal("0.5"),
    });
    const high = MonitorServer.calculateHealthScore({
      healthRatio: new Decimal("5.0"),
      drawdownPct: new Decimal("2.5"),
      deltaImbalance: new Decimal("0"),
      capitalUtilization: new Decimal("0.5"),
    });
    expect(low.score).toBeGreaterThan(high.score);
  });
});
