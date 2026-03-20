import Decimal from "decimal.js";
import { CapitalRampManager } from "../strategy/capital-ramp";

describe("CapitalRampManager", () => {
  it("starts at 10% deployment", () => {
    const ramp = new CapitalRampManager();
    const fraction = ramp.getDeploymentFraction();
    expect(fraction).toBe(0.1);
  });

  it("applies ramp to capital amount", () => {
    const ramp = new CapitalRampManager();
    const total = new Decimal(500_000);
    const { capped, fraction } = ramp.applyRamp(total);
    expect(fraction).toBe(0.1);
    expect(capped.toNumber()).toBe(50_000);
  });

  it("returns 100% when disabled", () => {
    const ramp = new CapitalRampManager({ disabled: true });
    const { capped } = ramp.applyRamp(new Decimal(500_000));
    expect(capped.toNumber()).toBe(500_000);
  });

  it("returns 100% after skipRamp()", () => {
    const ramp = new CapitalRampManager();
    expect(ramp.getDeploymentFraction()).toBe(0.1);
    ramp.skipRamp();
    expect(ramp.getDeploymentFraction()).toBe(1.0);
  });

  it("accelerates to next tier on positive PnL", () => {
    const ramp = new CapitalRampManager();
    // Day 0 = 10%, but with strong PnL should jump to 25%
    const fraction = ramp.getDeploymentFraction(0.01); // 1% PnL > 0.5% threshold
    expect(fraction).toBe(0.25);
  });

  it("does not accelerate past 100%", () => {
    const ramp = new CapitalRampManager({
      tiers: [{ day: 0, fraction: 1.0 }],
    });
    const fraction = ramp.getDeploymentFraction(0.5);
    expect(fraction).toBe(1.0);
  });

  it("getStatus reports correct tier", () => {
    const ramp = new CapitalRampManager();
    const status = ramp.getStatus();
    expect(status.currentTier).toBe("10%");
    expect(status.fullyDeployed).toBe(false);
    expect(status.elapsedDays).toBeGreaterThanOrEqual(0);
  });

  it("getStatus shows fully deployed when disabled", () => {
    const ramp = new CapitalRampManager({ disabled: true });
    const status = ramp.getStatus();
    expect(status.fullyDeployed).toBe(true);
    expect(status.currentFraction).toBe(1.0);
  });

  it("resetTimer starts the ramp over", () => {
    const ramp = new CapitalRampManager();
    ramp.skipRamp();
    expect(ramp.getDeploymentFraction()).toBe(1.0);
    ramp.resetTimer();
    expect(ramp.getDeploymentFraction()).toBe(0.1);
  });

  it("custom tiers work correctly", () => {
    const ramp = new CapitalRampManager({
      tiers: [
        { day: 0, fraction: 0.2 },
        { day: 5, fraction: 0.5 },
        { day: 10, fraction: 1.0 },
      ],
    });
    expect(ramp.getDeploymentFraction()).toBe(0.2);
  });
});
