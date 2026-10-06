import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_BEHAVIOR, type AgentDefinition, type ToolExecutor } from "../../src/modules/agents/index.js";
import {
  ConversationService,
  SPEND_FORCED_SHUTDOWN_MS,
  ScriptedConversationRuntime,
  type AudioFrame,
  type ConversationTransport,
} from "../../src/modules/conversation/index.js";
import { resetCallLiveness } from "../../src/modules/calls/index.js";

const audio = (value: number): AudioFrame => ({ data: new Uint8Array([value]), codec: "test/linear", sampleRate: 24_000, channels: 1 });

function sessionFixture(options: { spend: { maxDurationMs: number; maxTokens: number }; playback: boolean; inbound?: AsyncIterable<AudioFrame> }) {
  const runtime = new ScriptedConversationRuntime();
  const execute = vi.fn<ToolExecutor["execute"]>(async (_context, call) => ({ toolCallId: call.toolCallId, ok: true as const, data: {} }));
  const agent: AgentDefinition = {
    instructions: "Help the caller safely.",
    locale: "es-MX",
    voice: "neutral",
    conversation: { model: "gpt-realtime-2.1", maxOutputTokens: 512, reasoningEffort: "minimal", tracing: "disabled", truncation: { mode: "auto" } },
    audio: { voice: "neutral", noiseReduction: "near_field", turnDetection: { type: "server_vad", createResponse: true, interruptResponse: true } },
    behavior: structuredClone(DEFAULT_AGENT_BEHAVIOR),
    toolChoice: "auto",
    parallelToolCalls: false,
    channel: "phone",
    tools: [{ name: "check_availability", description: "Find times", inputSchema: { type: "object" } }],
    toolExecutor: { execute },
    trustedContext: { tenantId: "tenant-1", locationId: "default", callId: "spend-call", customerId: "customer-1" },
  };
  const written: AudioFrame[] = [];
  const closeTransport = vi.fn(async () => undefined);
  let idle: () => void = () => undefined;
  const transport: ConversationTransport = {
    inboundAudio: options.inbound ?? (async function* () { /* no caller audio */ })(),
    outboundAudio: {
      write: async (frame) => { written.push(frame); },
      ...(options.playback ? { onPlaybackIdle: (callback: () => void) => { idle = callback; return () => undefined; } } : {}),
    },
    close: closeTransport,
  };
  const service = new ConversationService({ runtime, spendLimit: options.spend });
  return { agent, closeTransport, execute, idle: () => idle(), runtime, service, transport, written };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 0)); }
  }
  throw lastError;
}

describe("per-call OpenAI spend cap", () => {
  afterEach(() => resetCallLiveness());

  it("asks for one polite farewell when summed tokens reach the cap and refuses later tools", async () => {
    let releaseSecondFrame: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseSecondFrame = resolve; });
    const consumed: number[] = [];
    async function* inbound() {
      yield audio(1);
      await gate;
      yield audio(2);
      consumed.push(2);
    }
    const value = sessionFixture({ spend: { maxDurationMs: 15 * 60_000, maxTokens: 100 }, playback: false, inbound: inbound() });
    const session = await value.service.start({ conversationId: "spend-1", agent: value.agent, transport: value.transport });
    await eventually(() => expect(value.runtime.latestSession.receivedAudio).toEqual([audio(1)]));

    value.runtime.latestSession.emit({ type: "usage", inputTokens: 40, outputTokens: 20 });
    value.runtime.latestSession.emit({ type: "usage", totalTokens: 40 });
    await eventually(() => expect(value.runtime.latestSession.requestedResponses).toHaveLength(1));
    expect(value.runtime.latestSession.requestedResponses[0]).toMatch(/farewell/i);
    expect(value.runtime.latestSession.requestedResponses[0]).toMatch(/limit/i);

    value.runtime.latestSession.emit({ type: "usage", totalTokens: 500 });
    value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "late", name: "check_availability", arguments: {} });
    await eventually(() => expect(value.runtime.latestSession.receivedToolResults).toHaveLength(1));
    expect(value.runtime.latestSession.receivedToolResults[0]).toMatchObject({
      ok: false, error: { code: "CALL_SPEND_LIMIT", retryable: false },
    });
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.runtime.latestSession.requestedResponses).toHaveLength(1);

    releaseSecondFrame();
    await eventually(() => expect(consumed).toEqual([2]));
    expect(value.runtime.latestSession.receivedAudio).toEqual([audio(1)]);

    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "completed" });
    await expect(session.completed).resolves.toEqual({ status: "closed", reason: "spend_limit" });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("wraps up a phone call when the minute cap is reached and closes after the farewell plays", async () => {
    const value = sessionFixture({ spend: { maxDurationMs: 25, maxTokens: 1_000_000 }, playback: true });
    const session = await value.service.start({ conversationId: "spend-2", agent: value.agent, transport: value.transport });
    await eventually(() => expect(value.runtime.latestSession.requestedResponses).toHaveLength(1));
    expect(value.runtime.latestSession.requestedResponses[0]).toMatch(/farewell/i);
    expect(value.runtime.latestSession.requestedResponses[0]).toMatch(/limit/i);

    value.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "farewell" });
    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "farewell", frame: audio(9) });
    value.runtime.latestSession.emit({ type: "assistant.audio_completed", assistantTurnId: "farewell" });
    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "completed" });
    await eventually(() => expect(value.written).toEqual([audio(9)]));
    expect(value.closeTransport).not.toHaveBeenCalled();
    value.idle();
    await eventually(() => expect(value.closeTransport).toHaveBeenCalledTimes(1));
    await expect(session.completed).resolves.toEqual({ status: "closed", reason: "spend_limit" });
  });

  it.each(["speech", "cancelled-response"])("still ends the call when the usage-limit farewell is interrupted by %s", async (cause) => {
    vi.useFakeTimers();
    const value = sessionFixture({ spend: { maxDurationMs: 15 * 60_000, maxTokens: 10 }, playback: true });
    const session = await value.service.start({ conversationId: "spend-interrupt", agent: value.agent, transport: value.transport });
    try {
      value.runtime.latestSession.emit({ type: "usage", totalTokens: 10 });
      await vi.advanceTimersByTimeAsync(0);
      expect(value.runtime.latestSession.requestedResponses).toHaveLength(1);
      if (cause === "speech") value.runtime.latestSession.emit({ type: "user.speech_started" });
      if (cause === "cancelled-response") value.runtime.latestSession.emit({ type: "assistant.response_done", status: "cancelled" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SPEND_FORCED_SHUTDOWN_MS - 1);
      expect(value.closeTransport).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await session.close();
      await expect(session.completed).resolves.toEqual({ status: "closed", reason: "spend_limit" });
      expect(value.closeTransport).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });
});
