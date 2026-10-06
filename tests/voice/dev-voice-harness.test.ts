import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachHarness } from "../../apps/dev-voice/harness.js";
import { buildApplication } from "../../src/bootstrap/build-application.js";
import { InMemoryCallRepository } from "../../src/modules/calls/index.js";
import { buildRealtimeSessionUpdate, ScriptedConversationRuntime, type ConversationTransport } from "../../src/modules/conversation/index.js";

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  messages: Record<string, unknown>[] = [];
  binary: Uint8Array[] = [];
  send(data: string | Uint8Array) { if (typeof data === "string") this.messages.push(JSON.parse(data)); else this.binary.push(data); }
  close = vi.fn(() => { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); });
  request(message: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
  audio() { this.emit("message", Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer), true); }
  events(name: string) { return this.messages.filter(message => message.event === name || message.type === name); }
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const until = async (assertion: () => void) => vi.waitFor(assertion, { interval: 1, timeout: 1000 });
const sockets: Socket[] = [];
function fixture() {
  const runtime = new ScriptedConversationRuntime();
  const open = runtime.openSession.bind(runtime);
  vi.spyOn(runtime, "openSession").mockImplementation(input => {
    buildRealtimeSessionUpdate(input.agent, "audio");
    return open(input);
  });
  const callRepository = new InMemoryCallRepository();
  const app = buildApplication({ runtime, callRepository, developerTestModeAuthorized: true, environment: {} });
  let transport: ConversationTransport;
  const register = app.registerCallMedia.bind(app);
  vi.spyOn(app, "registerCallMedia").mockImplementation((id, media) => { transport = media; return register(id, media); });
  function connect() {
    const socket = new Socket(); sockets.push(socket);
    attachHarness(socket as unknown as WebSocket, { app, callRepository, calledNumber: "+529991000000",
      transcriptEnabled: false, audioDebug: false });
    return socket;
  }
  async function start(socket: Socket) {
    socket.request({ type: "mic.start", sampleRate: 48_000, channels: 1 });
    await until(() => expect(socket.events("conversation.opened")).toHaveLength(1));
    return String(socket.events("conversation.opened")[0]!.callId);
  }
  async function farewell() {
    const session = runtime.latestSession;
    session.emit({ type: "assistant.response_created", responseId: "farewell-response" });
    session.emit({ type: "audio.delta", assistantTurnId: "farewell", frame: {
      data: new Uint8Array([1, 2, 3, 4]), codec: "pcm16", sampleRate: 24_000, channels: 1,
    } });
    session.emit({ type: "tool.call", toolCallId: "end", name: "end_call", arguments: {} });
    session.emit({ type: "assistant.audio_completed", assistantTurnId: "farewell" });
    session.emit({ type: "assistant.response_done", status: "completed" });
    await flush();
  }
  return { runtime, app, callRepository, connect, start, farewell, transport: () => transport! };
}
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await flush(); vi.restoreAllMocks(); });

describe("Dev Voice harness lifecycle with the real call orchestrator", () => {
  it("reports tool start, success and failure as distinct activity events", async () => {
    const f = fixture(), socket = f.connect(); await f.start(socket);
    const execution = { type: "tool.execution" as const, toolCallId: "service-info", name: "get_service_information" as const };
    f.transport().observeEvent?.({ ...execution, phase: "started" });
    expect(socket.events("realtime.tool.started")).toHaveLength(1);
    expect(socket.events("realtime.tool.failed")).toHaveLength(0);
    f.transport().observeEvent?.({ ...execution, phase: "completed" });
    expect(socket.events("realtime.tool.completed")).toHaveLength(1);
    expect(socket.events("realtime.tool.failed")).toHaveLength(0);
    f.transport().observeEvent?.({ ...execution, phase: "failed" });
    expect(socket.events("realtime.tool.failed")).toHaveLength(1);
  });

  it("starts audio, closes once on manual end, drains the queue and releases media", async () => {
    const f = fixture(), socket = f.connect(); const id = await f.start(socket);
    socket.audio(); await until(() => expect(f.runtime.latestSession.receivedAudio).toHaveLength(1));
    socket.request({ type: "close" }); socket.request({ type: "close" }); await flush();
    expect(f.runtime.latestSession.closeCount).toBe(1);
    expect(socket.events("conversation.closed")).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    await expect(f.callRepository.findByCallId(id)).resolves.toMatchObject({ state: "COMPLETED" });
    await expect(f.app.voice.open(id)).resolves.toMatchObject({ ok: false });
    await expect(f.transport().inboundAudio[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    expect(socket.listenerCount("message")).toBe(0);
  });

  it("completes a Voice Lab farewell only after the matching browser drain, with no second response", async () => {
    const f = fixture(), socket = f.connect(); const id = await f.start(socket);
    const delivery = vi.spyOn(f.runtime.latestSession, "sendToolResult");
    expect(f.runtime.openedInputs[0]!.agent.channel).toBe("voice_lab");
    await f.farewell();
    const finish = socket.events("playback.finish")[0]!;
    expect(finish).toMatchObject({ assistantTurnId: "farewell" });
    socket.request({ type: "playback.idle", assistantTurnId: "wrong", requestId: finish.requestId });
    await flush(); expect(socket.events("conversation.closed")).toHaveLength(0);
    socket.request({ type: "playback.idle", assistantTurnId: "farewell", requestId: finish.requestId });
    await until(() => expect(socket.events("conversation.closed")).toHaveLength(1));
    await flush();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith({ toolCallId: "end", ok: true, data: { ending: true } }, { requestResponse: false });
    expect(f.runtime.latestSession.closeCount).toBe(1);
    await expect(f.callRepository.findByCallId(id)).resolves.toMatchObject({ state: "COMPLETED" });
    await expect(f.app.voice.open(id)).resolves.toMatchObject({ ok: false });
  });

  it("cleans up a disconnect while runtime startup is still pending", async () => {
    const f = fixture(), socket = f.connect();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const open = f.runtime.openSession.bind(f.runtime);
    const starting = vi.spyOn(f.runtime, "openSession").mockImplementation(async input => { await waiting; return open(input); });
    socket.request({ type: "mic.start", sampleRate: 48_000, channels: 1 });
    await until(() => expect(starting).toHaveBeenCalledOnce());
    const id = String(socket.events("voice.lab.ready")[0]!.callId);
    socket.close(); release(); await flush();
    expect(f.runtime.latestSession.closeCount).toBe(1);
    expect(socket.events("conversation.opened")).toHaveLength(0);
    await expect(f.callRepository.findByCallId(id)).resolves.toMatchObject({ state: "COMPLETED" });
    await expect(f.app.voice.open(id)).resolves.toMatchObject({ ok: false });
  });

  it("drains a farewell generated after a function-only end request and closes once", async () => {
    const f = fixture(), socket = f.connect(); const id = await f.start(socket);
    const session = f.runtime.latestSession;
    session.emit({ type: "assistant.response_created", responseId: "end-tool" });
    session.emit({ type: "tool.call", toolCallId: "end", name: "end_call", arguments: {} });
    session.emit({ type: "assistant.response_done", status: "completed" });
    await flush(); expect(socket.events("playback.finish")).toHaveLength(0);
    session.emit({ type: "assistant.response_created", responseId: "farewell-response" });
    session.emit({ type: "audio.delta", assistantTurnId: "farewell", frame: {
      data: new Uint8Array([1, 2, 3, 4]), codec: "pcm16", sampleRate: 24_000, channels: 1,
    } });
    session.emit({ type: "assistant.audio_completed", assistantTurnId: "farewell" });
    session.emit({ type: "assistant.response_done", status: "completed" });
    await flush();
    const finish = socket.events("playback.finish")[0]!;
    expect(finish).toMatchObject({ assistantTurnId: "farewell" });
    expect(socket.events("conversation.closed")).toHaveLength(0);
    socket.request({ type: "playback.idle", assistantTurnId: "farewell", requestId: finish.requestId });
    await until(() => expect(socket.events("conversation.closed")).toHaveLength(1));
    await expect(f.callRepository.findByCallId(id)).resolves.toMatchObject({ state: "COMPLETED" });
    expect(session.closeCount).toBe(1);
    expect(session.receivedToolResults).toHaveLength(1);
  });

  it("manual completion racing with a runtime close finalizes once", async () => {
    const f = fixture(), socket = f.connect(); await f.start(socket);
    f.runtime.latestSession.emit({ type: "closed", reason: "finished" });
    socket.request({ type: "close" }); await flush();
    expect(f.runtime.latestSession.closeCount).toBe(1);
    expect(socket.events("conversation.closed")).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("reports runtime failure and completes cleanup instead of leaving the UI active", async () => {
    const f = fixture(), socket = f.connect(); const id = await f.start(socket);
    f.runtime.latestSession.emit({ type: "error", code: "RUNTIME_ERROR", message: "Synthetic failure", retryable: false });
    await flush();
    expect(socket.events("conversation.closed")).toEqual([expect.objectContaining({ failed: true, reason: "runtime_failed" })]);
    expect(f.runtime.latestSession.closeCount).toBe(1);
    await expect(f.callRepository.findByCallId(id)).resolves.toMatchObject({ state: "FAILED" });
  });

  it("reports a failed following farewell as a failed test and releases the call", async () => {
    const f = fixture(), socket = f.connect(); const id = await f.start(socket);
    f.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "end-tool" });
    f.runtime.latestSession.emit({ type: "tool.call", toolCallId: "end", name: "end_call", arguments: {} });
    f.runtime.latestSession.emit({ type: "assistant.response_done", status: "completed" });
    await flush();
    f.runtime.latestSession.emit({ type: "assistant.response_created", responseId: "farewell" });
    f.runtime.latestSession.emit({ type: "assistant.response_done", status: "failed" });
    await flush();
    expect(socket.events("error")).toEqual([expect.objectContaining({ code: "RUNTIME_ERROR", retryable: false })]);
    expect(socket.events("conversation.closed")).toEqual([expect.objectContaining({ failed: true, reason: "runtime_failed" })]);
    await expect(f.callRepository.findByCallId(id)).resolves.toMatchObject({ state: "FAILED" });
    expect(f.runtime.latestSession.closeCount).toBe(1);
  });

  it("gives the next test a new call ID and media queue, preserving call history and saved settings", async () => {
    const f = fixture(), first = f.connect();
    const configuration = await f.app.agentConfiguration.get(f.app.tenantId);
    const id1 = await f.start(first); first.audio(); await flush(); first.request({ type: "close" }); await flush();
    const second = f.connect(); const id2 = await f.start(second);
    expect(id2).not.toBe(id1); expect(f.runtime.sessions).toHaveLength(2);
    expect(f.runtime.latestSession.receivedAudio).toEqual([]);
    expect(f.runtime.latestSession.receivedText).toEqual([]);
    expect(f.runtime.latestSession.receivedToolResults).toEqual([]);
    expect(await f.app.agentConfiguration.get(f.app.tenantId)).toEqual(configuration);
    await expect(f.callRepository.findByCallId(id1)).resolves.toMatchObject({ state: "COMPLETED" });
    await expect(f.callRepository.findByCallId(id2)).resolves.toMatchObject({ state: "IN_CONVERSATION" });
    first.audio(); first.request({ type: "close" }); await flush();
    expect(f.runtime.latestSession.closeCount).toBe(0);
  });

  it("cancels an outstanding interruption acknowledgment when the browser disconnects", async () => {
    const f = fixture(), socket = f.connect(); await f.start(socket);
    await f.transport().outboundAudio.write({ data: new Uint8Array([1, 2]), sampleRate: 24_000, channels: 1, codec: "pcm16" }, "turn");
    const interrupt = vi.spyOn(f.app.calls, "interrupt");
    socket.request({ type: "interrupt" });
    expect(socket.events("playback.clear")).toHaveLength(1);
    socket.close(); await flush();
    expect(interrupt).not.toHaveBeenCalled(); expect(f.runtime.latestSession.closeCount).toBe(1);
  });

  it("does not forward buffered microphone frames after completion", async () => {
    const f = fixture(), socket = f.connect(); await f.start(socket);
    let release!: () => void;
    const sending = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(f.runtime.latestSession, "sendAudio").mockReturnValueOnce(sending);
    socket.audio(); socket.audio(); socket.audio(); await flush();
    expect(send).toHaveBeenCalledTimes(1);
    socket.request({ type: "close" }); release(); await flush();
    expect(send).toHaveBeenCalledTimes(1);
    await expect(f.transport().inboundAudio[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
  });
});
