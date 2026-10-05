import { describe, expect, it } from "vitest";
import {
  addRealtimeUsage,
  emptyRealtimeSessionUsage,
  estimateRealtimeCost,
  emptyRealtimeCostState,
  observeRealtimeCostEvent,
} from "../../dashboard/src/services/realtime-cost.js";

describe("Realtime cost estimate", () => {
  it("resets only on a fresh test and completes once without accepting stale usage", () => {
    let state = emptyRealtimeCostState();
    const event = (name: string, time: number, values = {}) => { state = observeRealtimeCostEvent(state, { event: name, ...values }, time); };
    event("test.started", 1); event("conversation.opened", 2);
    event("usage", 3, { inputTokens: 50, outputAudioTokens: 100, toolCalls: 2 });
    event("microphone.paused", 4); event("microphone.enabled", 5);
    expect(state.usage.inputTokens).toBe(50); expect(state.startedAt).toBe(2);
    event("test.completed", 6); event("conversation.closed", 7); event("usage", 8, { inputTokens: 900 });
    expect(state.endedAt).toBe(6); expect(state.usage.inputTokens).toBe(50);
    event("test.started", 10); expect(state).toEqual(emptyRealtimeCostState());
    event("conversation.opened", 11); event("usage", 12, { inputTokens: 20 });
    expect(state.startedAt).toBe(11); expect(state.usage.inputTokens).toBe(20); expect(state.usage.toolCalls).toBe(0);
  });
  it("accumulates provider usage and applies text, audio and cache rates", () => {
    const usage = addRealtimeUsage(emptyRealtimeSessionUsage(), {
      inputTokens: 1_100,
      outputTokens: 250,
      inputTextTokens: 1_000,
      outputTextTokens: 200,
      inputAudioTokens: 100,
      outputAudioTokens: 50,
      cachedInputTokens: 420,
      cachedInputTextTokens: 400,
      cachedInputAudioTokens: 20,
      toolCalls: 2,
    });
    const cost = estimateRealtimeCost(usage, {
      currency: "USD", unitTokens: 1_000_000, verifiedAt: "2026-09-21", sourceUrl: "https://example.test",
      text: { input: 4, cachedInput: 0.4, output: 24 },
      audio: { input: 32, cachedInput: 0.4, output: 64 },
    });

    expect(cost).toBeCloseTo(0.013128, 8);
    expect(usage.toolCalls).toBe(2);
  });
});
