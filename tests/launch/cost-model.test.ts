import { describe, expect, it } from "vitest";
import { builtInScenarios, estimatePilotCost, TELNYX_US_LIST } from "../../src/launch/cost-model.js";

describe("pilot cost model", () => {
  it("prices a 50-minute Telnyx example from published token rates", () => {
    const estimate = estimatePilotCost({
      inboundMinutes: 50,
      didMonthlyUsd: TELNYX_US_LIST.didMonthlyUsd,
      inboundPerMinuteUsd: TELNYX_US_LIST.inboundPerMinuteUsd,
      hostMonthlyUsd: 0,
    });
    expect(estimate.inferenceUsd).toBe(2.16);
    expect(estimate.telephonyUsd).toBe(1.16);
    expect(estimate.totalUsd).toBe(3.32);
    expect(estimate.withinTwentyDollarEnvelope).toBe(true);
  });

  it("keeps the zero-cost demo at zero and shows a 2 GB host can leave the envelope", () => {
    const scenarios = Object.fromEntries(builtInScenarios().map((item) => [item.name, item.estimate]));
    expect(scenarios["demo-zero"]?.totalUsd).toBe(0);
    expect(scenarios["demo-zero"]?.withinTwentyDollarEnvelope).toBe(true);
    expect(scenarios["owner-hardware-50"]?.withinTwentyDollarEnvelope).toBe(true);
    expect(scenarios["lightsail-2gb-200"]?.withinTwentyDollarEnvelope).toBe(false);
    expect(scenarios["lightsail-2gb-200"]?.hostUsd).toBe(12);
  });

  it("rejects speech fractions that overlap", () => {
    expect(() => estimatePilotCost({
      inboundMinutes: 10,
      callerSpeechFraction: 0.8,
      assistantSpeechFraction: 0.8,
      didMonthlyUsd: 0,
      inboundPerMinuteUsd: 0,
      hostMonthlyUsd: 0,
    })).toThrow(/Speech fractions/);
  });
});
