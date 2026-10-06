import { describe, expect, it, vi } from "vitest";
import {
  buildApplication,
  type Clock,
  type IdGenerator,
} from "../../src/bootstrap/index.js";
import { OpenAIRealtimeAdapter, ScriptedConversationRuntime } from "../../src/modules/conversation/index.js";

const noAudio = async function* () {};

describe("buildApplication", () => {
  it("constructs YIBO and starts and closes a call through the composed runtime", async () => {
    const clock: Clock = { now: () => new Date("2026-08-25T12:00:00.000Z") };
    let sequence = 0;
    const ids: IdGenerator = { generate: (scope) => `${scope}-${++sequence}` };
    const app = buildApplication({ clock, ids });
    const closeMedia = vi.fn(async () => undefined);
    app.registerCallMedia("call-bootstrap-1", {
      inboundAudio: noAudio(),
      outboundAudio: { write: vi.fn() },
      close: closeMedia,
    });

    await app.calls.handleTelephonyEvent({
      type: "INCOMING_CALL",
      callId: "call-bootstrap-1",
      from: "+529991234567",
      to: "+529991000000",
      occurredAt: "2026-08-25T12:00:00.000Z",
    });

    expect(app.runtime).toBeInstanceOf(ScriptedConversationRuntime);
    expect(app.telephony.answeredCallIds).toEqual(["call-bootstrap-1"]);
    expect((app.runtime as ScriptedConversationRuntime).openedInputs).toHaveLength(1);

    await app.calls.handleTelephonyEvent({
      type: "CALL_HUNG_UP",
      callId: "call-bootstrap-1",
      occurredAt: "2026-08-25T12:05:00.000Z",
    });

    expect((app.runtime as ScriptedConversationRuntime).latestSession.closeCount).toBe(1);
    expect(closeMedia).toHaveBeenCalledTimes(1);
  });

  it("constructs the realtime adapter for a validated OpenAI configuration", () => {
    const app = buildApplication({
      config: {
        runtime: "openai-realtime",
        openAiApiKey: "test-key",
        openAiRealtimeModel: "gpt-realtime-2.1",
        conversationVoice: "marin",
        maxOutputTokens: 512,
        callMaxDurationMs: 15 * 60_000,
        callMaxTokens: 150_000,
        dashboardOrigin: "http://localhost:5173",
      },
    });
    expect(app.runtime).toBeInstanceOf(OpenAIRealtimeAdapter);
  });

  it("accepts an injected runtime for the validated realtime configuration", () => {
    const runtime = new ScriptedConversationRuntime();
    const app = buildApplication({
      config: {
        runtime: "openai-realtime",
        openAiApiKey: "test-key",
        openAiRealtimeModel: "gpt-realtime-2.1",
        conversationVoice: "marin",
        maxOutputTokens: 512,
        callMaxDurationMs: 15 * 60_000,
        callMaxTokens: 150_000,
        dashboardOrigin: "http://localhost:5173",
      },
      runtime,
    });

    expect(app.runtime).toBe(runtime);
  });
});
