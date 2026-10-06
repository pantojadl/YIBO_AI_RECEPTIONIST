import { operationalLog } from "../../src/shared/observability/operational-log.js";
import { isCallEnded, markCallEnded, resetCallLiveness, configureCallLiveness, MemoryCallLivenessStore, restoreDefaultCallLiveness } from "../../src/modules/calls/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_BEHAVIOR, type AgentDefinition, type AgentToolResult, type ToolExecutor } from "../../src/modules/agents/index.js";
import {
  ConversationService,
  ScriptedConversationRuntime,
  type AudioFrame,
  type ConversationTransport,
} from "../../src/modules/conversation/index.js";

const trustedContext = {
  tenantId: "tenant-1",
  locationId: "default",
  callId: "call-1",
  customerId: "customer-1",
};

const audio = (value: number, codec = "test/linear"): AudioFrame => ({
  data: new Uint8Array([value]),
  codec,
  sampleRate: 24_000,
  channels: 1,
});

const stream = async function* (...frames: AudioFrame[]): AsyncGenerator<AudioFrame> {
  for (const frame of frames) yield frame;
};

function fixture(inboundAudio: AsyncIterable<AudioFrame> = stream()) {
  const runtime = new ScriptedConversationRuntime();
  const execute = vi.fn<ToolExecutor["execute"]>(async (_context, call) => ({
    toolCallId: call.toolCallId,
    ok: true as const,
    data: { slots: ["2026-08-26T15:00:00.000Z"] },
  }));
  const toolExecutor: ToolExecutor = { execute };
  const agent: AgentDefinition = {
    instructions: "Help the caller safely.",
    locale: "es-MX",
    voice: "neutral",
    conversation: {
      model: "gpt-realtime-2.1", maxOutputTokens: 512, reasoningEffort: "minimal",
      tracing: "disabled", truncation: { mode: "auto" },
    },
    audio: {
      voice: "neutral", noiseReduction: "near_field",
      turnDetection: { type: "server_vad", createResponse: true, interruptResponse: true },
    },
    behavior: structuredClone(DEFAULT_AGENT_BEHAVIOR),
    toolChoice: "auto",
    parallelToolCalls: false,
    channel: "phone",
    tools: [{
      name: "check_availability",
      description: "Find available appointment times",
      inputSchema: { type: "object" },
    }],
    toolExecutor,
    trustedContext,
  };
  const writtenAudio: AudioFrame[] = [];
  const closeTransport = vi.fn(async () => undefined);
  const interruptPlayback = vi.fn(async () => undefined as { assistantTurnId: string; audioEndMs: number } | undefined);
  const transport: ConversationTransport = {
    inboundAudio,
    outboundAudio: {
      write: async (frame) => { writtenAudio.push(frame); },
      interrupt: interruptPlayback,
    },
    close: closeTransport,
  };
  const service = new ConversationService({ runtime });

  return { agent, closeTransport, execute, interruptPlayback, runtime, service, transport, writtenAudio };
}

const start = (value: ReturnType<typeof fixture>) => value.service.start({
  conversationId: "conversation-1",
  agent: value.agent,
  transport: value.transport,
});

describe("ConversationService", () => {
  afterEach(() => resetCallLiveness());

  it("runs one side effect when the same voice tool call is delivered twice", async () => {
    const value = fixture();
    const session = await start(value);
    const event = { type: "tool.call" as const, toolCallId: "same-tool", name: "check_availability" as const, arguments: {} };
    value.runtime.latestSession.emit(event);
    value.runtime.latestSession.emit(event);
    await eventually(() => expect(value.execute).toHaveBeenCalledTimes(1));
    await session.close();
  });

  it("keeps the hangup mark until an in-flight tool finishes past the old ttl", async () => {
    let now = 1_000;
    const memory = new MemoryCallLivenessStore();
    configureCallLiveness({ store: memory, now: () => now, ttlMs: 50 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let endedDuringTool = false;
    const value = fixture();
    value.execute.mockImplementation(async (context, call) => {
      markCallEnded(context.callId);
      now += 1_000;
      endedDuringTool = isCallEnded(context.callId);
      await gate;
      return { toolCallId: call.toolCallId, ok: true as const, data: {} };
    });
    const session = await start(value);
    try {
      value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "slow", name: "check_availability", arguments: {} });
      await eventually(() => expect(endedDuringTool).toBe(true));
      expect(isCallEnded("call-1")).toBe(true);
      release();
      await eventually(() => expect(value.runtime.latestSession.receivedToolResults).toHaveLength(1));
      expect(isCallEnded("call-1")).toBe(false);
      await session.close();
    } finally {
      restoreDefaultCallLiveness();
    }
  });

  it("correlates tool diagnostics and emits one summary on cleanup without caller content", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const value = fixture();
    value.execute.mockImplementation(async (_context, call) => {
      await Promise.resolve();
      operationalLog("calendar.test", { transcript: "private caller words", calendarId: "private@example.com" });
      return { toolCallId: call.toolCallId, ok: false, error: { code: "CONFIRMATION_REQUIRED", messageForAgent: "private caller words", retryable: false } };
    });
    const session = await start(value);
    try {
      value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "secret-tool-id", name: "create_appointment", arguments: { name: "Patient Secret" } });
      await eventually(() => expect(value.runtime.latestSession.receivedToolResults).toHaveLength(1));
      await session.close(); await session.close();
      const records = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      const tool = records.find(record => record.event === "calendar.test");
      const summary = records.filter(record => record.event === "conversation.latency_summary" && record.metric === "session_duration");
      expect(summary).toHaveLength(1); expect(tool.call).toBe(summary[0].call); expect(tool.tenant).toBe(summary[0].tenant);
      expect(records.some(record => record.event === "conversation.confirmation")).toBe(true);
      expect(JSON.stringify(records)).not.toMatch(/private caller words|private@example.com|Patient Secret|secret-tool-id/);
    } finally { await session.close(); logged.mockRestore(); }
  });

  it("opens one runtime session and moves audio in both directions without assuming a codec", async () => {
    const inbound = [audio(1, "audio/custom-a"), audio(2, "audio/custom-b")];
    const value = fixture(stream(...inbound));
    const session = await start(value);

    expect(value.runtime.openedInputs).toEqual([{
      conversationId: "conversation-1",
      agent: {
        instructions: value.agent.instructions,
        locale: value.agent.locale,
        voice: value.agent.voice,
        conversation: value.agent.conversation,
        audio: value.agent.audio,
        behavior: value.agent.behavior,
        toolChoice: value.agent.toolChoice,
        parallelToolCalls: value.agent.parallelToolCalls,
        channel: value.agent.channel,
        tools: value.agent.tools,
      },
    }]);
    await eventually(() => expect(value.runtime.latestSession.receivedAudio).toEqual(inbound));

    const outbound = audio(3, "audio/custom-c");
    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-1", frame: outbound });
    await eventually(() => expect(value.writtenAudio).toEqual([outbound]));

    value.runtime.latestSession.emit({ type: "closed", reason: "runtime-completed" });
    await expect(session.completed).resolves.toEqual({ status: "closed", reason: "runtime-completed" });
    await eventually(() => expect(value.closeTransport).toHaveBeenCalledTimes(1));
  });

  it("executes tool calls with trusted context and returns the correlated result", async () => {
    const value = fixture();
    const session = await start(value);

    value.runtime.latestSession.emit({ type: "user.speech_started" });
    value.runtime.latestSession.emit({
      type: "tool.call",
      toolCallId: "tool-42",
      name: "check_availability",
      arguments: { serviceId: "service-1" },
    });

    await eventually(() => expect(value.execute).toHaveBeenCalledWith({ ...trustedContext, turnSequence: 1 }, {
      toolCallId: "tool-42",
      name: "check_availability",
      arguments: { serviceId: "service-1" },
    }));
    await eventually(() => expect(value.runtime.latestSession.receivedToolResults).toEqual([{
      toolCallId: "tool-42",
      ok: true,
      data: { slots: ["2026-08-26T15:00:00.000Z"] },
    }]));

    await session.close();
  });

  it("forwards a confirmation token to the runtime without placing it in trusted context", async () => {
    const value = fixture();
    value.execute.mockResolvedValueOnce({
      toolCallId: "mutation-1",
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
        messageForAgent: "Ask the caller to confirm.",
        retryable: false,
        confirmationToken: "opaque-token",
      },
    });
    const session = await start(value);
    value.runtime.latestSession.emit({
      type: "tool.call", toolCallId: "mutation-1", name: "create_appointment", arguments: {},
    });

    await eventually(() => expect(value.runtime.latestSession.receivedToolResults).toEqual([{
      toolCallId: "mutation-1",
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Ask the caller to confirm.",
        retryable: false,
        confirmationToken: "opaque-token",
      },
    }]));
    await session.close();
  });

  it("reports a runtime error and closes all resources", async () => {
    const value = fixture();
    const session = await start(value);

    value.runtime.latestSession.emit({
      type: "error",
      code: "TEMPORARILY_UNAVAILABLE",
      message: "Conversation runtime is temporarily unavailable",
      retryable: true,
    });

    await expect(session.completed).resolves.toEqual({
      status: "failed",
      error: {
        code: "RUNTIME_ERROR",
        message: "Conversation runtime is temporarily unavailable",
        retryable: true,
      },
    });
    await eventually(() => expect(value.runtime.latestSession.closeCount).toBe(1));
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("delegates interruption to the active runtime session", async () => {
    const value = fixture();
    const session = await start(value);

    await session.interrupt();

    expect(value.runtime.latestSession.interruptCount).toBe(1);
    await session.close();
  });

  it("stops local playback, interrupts the runtime, and drops stale audio on barge-in", async () => {
    const value = fixture();
    const session = await start(value);
    value.interruptPlayback.mockResolvedValue({ assistantTurnId: "assistant-1", audioEndMs: 420 });

    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-1", frame: audio(1) });
    await eventually(() => expect(value.writtenAudio).toHaveLength(1));
    value.runtime.latestSession.emit({ type: "user.speech_started" });
    await eventually(() => expect(value.runtime.latestSession.interruptions).toEqual([{
      assistantTurnId: "assistant-1",
      audioEndMs: 420,
    }]));

    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-1", frame: audio(2) });
    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-2", frame: audio(3) });
    await eventually(() => expect(value.writtenAudio.map((frame) => frame.data[0])).toEqual([1, 3]));
    await session.close();
  });

  it("handles repeated interruptions and keeps forwarding the newest assistant turn", async () => {
    const value = fixture();
    const session = await start(value);
    value.interruptPlayback
      .mockResolvedValueOnce({ assistantTurnId: "assistant-1", audioEndMs: 220 })
      .mockResolvedValueOnce({ assistantTurnId: "assistant-2", audioEndMs: 140 });

    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-1", frame: audio(1) });
    await eventually(() => expect(value.writtenAudio).toHaveLength(1));
    value.runtime.latestSession.emit({ type: "user.speech_started" });
    await eventually(() => expect(value.runtime.latestSession.interruptions).toEqual([{ assistantTurnId: "assistant-1", audioEndMs: 220 }]));

    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-2", frame: audio(2) });
    await eventually(() => expect(value.writtenAudio.map((frame) => frame.data[0])).toEqual([1, 2]));
    value.runtime.latestSession.emit({ type: "user.speech_started" });
    await eventually(() => expect(value.runtime.latestSession.interruptions).toEqual([
      { assistantTurnId: "assistant-1", audioEndMs: 220 },
      { assistantTurnId: "assistant-2", audioEndMs: 140 },
    ]));

    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "assistant-3", frame: audio(3) });
    await eventually(() => expect(value.writtenAudio.map((frame) => frame.data[0])).toEqual([1, 2, 3]));
    await session.close();
  });

  it("keeps receiving speech events while an interrupted calendar tool is still completing", async () => {
    const value = fixture();
    let resolveTool!: (result: AgentToolResult) => void;
    value.execute.mockImplementationOnce(() => new Promise<AgentToolResult>((resolve) => { resolveTool = resolve; }));
    const observed: string[] = [];
    const session = await value.service.start({
      conversationId: "conversation-1", agent: value.agent, transport: value.transport,
      observeEvent: (event) => observed.push(event.type),
    });

    value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "calendar-1", name: "check_availability", arguments: { dateExpression: "Tuesday" } });
    await eventually(() => expect(value.execute).toHaveBeenCalledTimes(1));
    value.runtime.latestSession.emit({ type: "user.speech_started" });
    value.runtime.latestSession.emit({ type: "user.speech_stopped" });
    await eventually(() => expect(observed).toEqual(expect.arrayContaining(["tool.call", "tool.execution", "user.speech_started", "user.speech_stopped"])));

    resolveTool({ toolCallId: "calendar-1", ok: true, data: { earliestSlot: "2026-09-02T16:00:00.000Z" } });
    await eventually(() => expect(value.runtime.latestSession.receivedToolResults).toEqual([{
      toolCallId: "calendar-1", ok: true, data: { earliestSlot: "2026-09-02T16:00:00.000Z" },
    }]));
    await session.close();
  });

  it.each(["sí", "no"])("keeps a one-word '%s' turn when no assistant audio is playing", async () => {
    const value = fixture(stream(audio(1)));
    const session = await start(value);

    value.runtime.latestSession.emit({ type: "user.speech_started" });
    value.runtime.latestSession.emit({ type: "user.speech_stopped" });

    await eventually(() => expect(value.interruptPlayback).toHaveBeenCalledTimes(1));
    expect(value.runtime.latestSession.interruptCount).toBe(0);
    await session.close();
  });

  it("preserves server VAD boundaries for a correction followed by a long pause", async () => {
    const value = fixture();
    const observed: string[] = [];
    const session = await value.service.start({
      conversationId: "conversation-1",
      agent: value.agent,
      transport: value.transport,
      observeEvent: (event) => observed.push(event.type),
    });

    value.runtime.latestSession.emit({ type: "user.speech_started" });
    value.runtime.latestSession.emit({ type: "user.speech_stopped" });
    value.runtime.latestSession.emit({ type: "user.speech_started" });
    value.runtime.latestSession.emit({ type: "user.speech_stopped" });

    await eventually(() => expect(observed).toEqual([
      "user.speech_started",
      "user.speech_stopped",
      "user.speech_started",
      "user.speech_stopped",
    ]));
    await session.close();
  });

  it("does not invent a turn or interruption from silent audio frames", async () => {
    const value = fixture(stream(audio(0), audio(0), audio(0)));
    const session = await start(value);

    await eventually(() => expect(value.runtime.latestSession.receivedAudio).toHaveLength(3));
    expect(value.interruptPlayback).not.toHaveBeenCalled();
    expect(value.runtime.latestSession.interruptCount).toBe(0);
    await session.close();
  });

  it("preserves the server-side silence timeout event without freezing the conversation", async () => {
    const value = fixture();
    const observed: string[] = [];
    const session = await value.service.start({
      conversationId: "conversation-1", agent: value.agent, transport: value.transport,
      observeEvent: (event) => observed.push(event.type),
    });
    value.runtime.latestSession.emit({ type: "silence.timeout" });
    await eventually(() => expect(observed).toEqual(["silence.timeout"]));
    await session.close();
  });

  it("closes the runtime and transport only once when close is called twice", async () => {
    const value = fixture();
    const session = await start(value);

    await Promise.all([session.close(), session.close()]);

    expect(value.runtime.latestSession.closeCount).toBe(1);
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
    await expect(session.completed).resolves.toEqual({ status: "closed" });
  });
});

describe("integrated lifecycle deadlines",()=>{
 it("returns an uncertain mutation once and prevents another mutation after timeout",async()=>{
  vi.useFakeTimers();const value=fixture();let resolve!: (r:AgentToolResult)=>void;
  value.execute.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const session=await start(value);
  try {
   value.runtime.latestSession.emit({type:"tool.call",toolCallId:"slow",name:"create_appointment",arguments:{}});
   await vi.advanceTimersByTimeAsync(12000);
   expect(value.runtime.latestSession.receivedToolResults[0]).toMatchObject({ok:false,error:{code:"ACTION_OUTCOME_UNKNOWN"}});
   resolve({toolCallId:"slow",ok:true,data:{}});await vi.advanceTimersByTimeAsync(0);
   value.runtime.latestSession.emit({type:"tool.call",toolCallId:"retry",name:"create_appointment",arguments:{}});await vi.advanceTimersByTimeAsync(0);
   expect(value.execute).toHaveBeenCalledTimes(1);expect(value.runtime.latestSession.receivedToolResults).toHaveLength(2);
  } finally {await session.close();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();}
 });
 it("settles an unexpected runtime stream end",async()=>{
  const value=fixture();const session=await start(value);await value.runtime.latestSession.close();
  expect(await session.completed).toMatchObject({status:"closed"});await session.close();expect(value.closeTransport).toHaveBeenCalledTimes(1);
 });
});

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}


describe("intentional phone completion", () => {
  let value: ReturnType<typeof fixture>;
  let session: Awaited<ReturnType<typeof start>>;
  let idle: () => void;
  beforeEach(async () => {
    resetCallLiveness();
    vi.useFakeTimers();
    value = fixture();
    value.transport.outboundAudio.onPlaybackIdle = callback => { idle = callback; return vi.fn(); };
    session = await start(value);
  });
  afterEach(async () => { await session.close(); vi.useRealTimers(); });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  async function farewell() {
    value.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "final" });
    value.runtime.latestSession.emit({ type: "audio.delta", assistantTurnId: "farewell", frame: audio(1) });
    await flush();
  }
  async function end(id = "end", args: unknown = {}) {
    value.runtime.latestSession.emit({ type: "tool.call", toolCallId: id, name: "end_call", arguments: args });
    await flush();
  }
  async function done() {
    value.runtime.latestSession.emit({ type: "assistant.audio_completed", assistantTurnId: "farewell" });
    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "completed" });
    await flush();
  }

  it.each([true, false])("waits for final generation and audio drain, idle first=%s", async idleFirst => {
    const delivery = vi.spyOn(value.runtime.latestSession, "sendToolResult");
    await farewell(); await end();
    if (idleFirst) { idle(); await flush(); } else await done();
    expect(value.closeTransport).not.toHaveBeenCalled();
    if (idleFirst) await done(); else idle();
    await vi.advanceTimersByTimeAsync(19);
    expect(value.closeTransport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await session.completed).toEqual({ status: "closed", reason: "conversation_completed" });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith({ toolCallId: "end", ok: true, data: { ending: true } }, { requestResponse: false });
    expect(value.execute).not.toHaveBeenCalled();
  });

  it.each(["voice_lab_without_playback", "disabled", "parallel", "no-playback-signal"])("does not expose call end for %s", async mode => {
    await session.close();
    if (mode === "voice_lab_without_playback") {
      value.agent.channel = "voice_lab";
      delete value.transport.outboundAudio.onPlaybackIdle;
    }
    if (mode === "disabled") value.agent.toolChoice = "none";
    if (mode === "parallel") value.agent.parallelToolCalls = true;
    if (mode === "no-playback-signal") delete value.transport.outboundAudio.onPlaybackIdle;
    session = await start(value);
    expect(value.runtime.openedInputs.at(-1)!.agent.tools.some(tool => tool.name === "end_call")).toBe(false);
    await farewell(); await end();
    expect(value.runtime.latestSession.receivedToolResults[0]).toMatchObject({ ok: false });
  });

  it("allows Voice Lab to reuse farewell completion when the browser reports playback idle", async () => {
    await session.close();
    value.closeTransport.mockClear();
    value.agent.channel = "voice_lab";
    session = await start(value);
    const delivery = vi.spyOn(value.runtime.latestSession, "sendToolResult");
    expect(value.runtime.openedInputs.at(-1)!.agent.tools.some(tool => tool.name === "end_call")).toBe(true);
    await farewell(); await end(); await done();
    expect(value.closeTransport).not.toHaveBeenCalled();
    idle(); await vi.advanceTimersByTimeAsync(20);
    expect(await session.completed).toEqual({ status: "closed", reason: "conversation_completed" });
    expect(delivery).toHaveBeenCalledWith({ toolCallId: "end", ok: true, data: { ending: true } }, { requestResponse: false });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("allows a farewell after a known failed booking without claiming booking success", async () => {
    value.execute.mockResolvedValue({ toolCallId: "failed-booking", ok: false, error: { code: "CALENDAR_SYNC_FAILED", messageForAgent: "Not booked", retryable: false } });
    value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "failed-booking", name: "create_appointment", arguments: {} });
    await flush(); await farewell(); await end(); await done(); idle();
    await vi.advanceTimersByTimeAsync(20);
    expect(value.runtime.latestSession.receivedToolResults).toEqual([
      expect.objectContaining({ ok: false }), { toolCallId: "end", ok: true, data: { ending: true } },
    ]);
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("does not end an ordinary completed response", async () => {
    await farewell(); await done(); idle(); await vi.advanceTimersByTimeAsync(46_000);
    expect(value.closeTransport).not.toHaveBeenCalled();
  });

  it.each([{ callId: "foreign" }, null, []])("rejects an end request with hostile args %j", async args => {
    await farewell();
    await end("bad", args);
    expect(value.runtime.latestSession.receivedToolResults[0]).toMatchObject({ ok: false });
    expect(value.closeTransport).not.toHaveBeenCalled();
  });

  it.each(["phone", "voice_lab"] as const)("completes a function-only end request after exactly one following farewell (%s)", async channel => {
    await session.close(); value.closeTransport.mockClear(); value.agent.channel = channel; session = await start(value);
    const delivery = vi.spyOn(value.runtime.latestSession, "sendToolResult");
    value.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "end-tool" });
    await end(); await end(); await end("repeat");
    expect(delivery.mock.calls.filter(([, options]) => options?.requestResponse)).toHaveLength(1);
    expect(delivery.mock.calls[0]).toEqual([expect.objectContaining({ ok: true, data: expect.objectContaining({ farewellRequired: true }) }), { requestResponse: true }]);
    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "completed" });
    idle(); await flush(); expect(value.closeTransport).not.toHaveBeenCalled();
    await farewell(); await done();
    expect(value.closeTransport).not.toHaveBeenCalled();
    idle(); await vi.advanceTimersByTimeAsync(20);
    expect(await session.completed).toEqual({ status: "closed", reason: "conversation_completed" });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it.each(["caller", "tool", "cancelled", "extra-response"])("cancels a requested following farewell on %s", async cause => {
    await end();
    if (cause === "caller") value.runtime.latestSession.emit({ type: "user.speech_started" });
    if (cause === "tool") value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "lookup", name: "check_availability", arguments: {} });
    if (cause === "cancelled") value.runtime.latestSession.emit({ type: "assistant.response_done", status: "cancelled" });
    if (cause === "extra-response") value.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "unexpected" });
    await flush(); await farewell(); await done(); idle(); await vi.advanceTimersByTimeAsync(46_000);
    expect(value.closeTransport).not.toHaveBeenCalled();
  });

  it("bounds a function-only end request when no farewell audio follows", async () => {
    await end();
    value.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "silent" });
    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "completed" });
    idle(); await vi.advanceTimersByTimeAsync(45_000);
    expect(await session.completed).toMatchObject({ status: "failed" });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("cleans up a failed farewell response instead of silently waiting for another caller turn", async () => {
    await end();
    value.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "failed-farewell" });
    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "failed" });
    await flush();
    expect(await session.completed).toMatchObject({ status: "failed", error: { code: "RUNTIME_ERROR" } });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores duplicate delivery and acknowledges repeated end IDs without extra speech", async () => {
    const delivery = vi.spyOn(value.runtime.latestSession, "sendToolResult");
    await farewell(); await end(); await end(); await end("repeat");
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(delivery.mock.calls.every(([, options]) => options?.requestResponse === false)).toBe(true);
    await done(); idle(); await vi.advanceTimersByTimeAsync(20);
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it.each(["speech", "text", "interrupt"])("cancels end when caller intervenes through %s", async kind => {
    await farewell(); await end(); await done(); idle();
    if (kind === "speech") value.runtime.latestSession.emit({ type: "user.speech_started" });
    if (kind === "text") await session.sendText("One more question");
    if (kind === "interrupt") await session.interrupt();
    await vi.advanceTimersByTimeAsync(46_000);
    expect(value.closeTransport).not.toHaveBeenCalled();
  });

  it("does not accept an end request while a booking is pending or uncertain", async () => {
    value.execute.mockImplementation(() => new Promise(() => {}));
    await farewell();
    value.runtime.latestSession.emit({ type: "tool.call", toolCallId: "booking", name: "create_appointment", arguments: {} });
    await flush(); await farewell(); await end("pending");
    expect(value.runtime.latestSession.receivedToolResults[0]).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(12_001); await farewell(); await end("uncertain");
    expect(value.runtime.latestSession.receivedToolResults.at(-1)).toMatchObject({ ok: false });
    expect(value.closeTransport).not.toHaveBeenCalled();
  });

  it("waits for the end acknowledgment before closing", async () => {
    let release!: () => void;
    vi.spyOn(value.runtime.latestSession, "sendToolResult").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await farewell(); await end(); await done(); idle(); await vi.advanceTimersByTimeAsync(30);
    expect(value.closeTransport).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(20);
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending end when the response is cancelled", async () => {
    await farewell(); await end();
    value.runtime.latestSession.emit({ type: "assistant.response_done", status: "cancelled" });
    idle(); await vi.advanceTimersByTimeAsync(46_000);
    expect(value.closeTransport).not.toHaveBeenCalled();
  });

  it("bounds missing completion signals and cleans up once", async () => {
    await farewell(); await end();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await session.completed).toMatchObject({ status: "failed" });
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
  });

  it("caller hangup cancels the end deadline", async () => {
    await farewell(); await end(); await session.close();
    await vi.advanceTimersByTimeAsync(46_000);
    expect(value.closeTransport).toHaveBeenCalledTimes(1);
    expect(value.runtime.latestSession.closeCount).toBe(1);
  });
});

it("records the call as ended as soon as the conversation closes", async () => {
  resetCallLiveness();
  const value = fixture();
  const session = await start(value);
  expect(isCallEnded("call-1")).toBe(false);
  await session.close();
  expect(isCallEnded("call-1")).toBe(true);
  resetCallLiveness();
});
