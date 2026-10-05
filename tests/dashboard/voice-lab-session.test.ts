import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceLabSession, type VoiceLabSnapshot } from "../../apps/dev-voice/voice-lab-session.js";
import { previewBlockReason } from "../../dashboard/src/services/voice-preview.js";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Socket extends EventTarget {
  readyState = 1;
  binaryType = "arraybuffer";
  sent: unknown[] = [];
  removed = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event("close")); });
  send(data: string | ArrayBuffer) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: data instanceof ArrayBuffer ? data : JSON.stringify(data) })); }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) { this.removed(args[0]); super.removeEventListener(...args); }
}
class Node {
  buffer?: { duration: number };
  onended: (() => void) | null = null;
  onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => this.onended?.());
  end() { this.onended?.(); }
}
class Context {
  state = "running";
  currentTime = 0;
  sampleRate = 48_000;
  destination = {};
  nodes: Node[] = [];
  source = new Node();
  processor = new Node();
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createMediaStreamSource() { return this.source; }
  createScriptProcessor() { return this.processor; }
  createBuffer(_channels: number, samples: number, rate: number) { return { duration: samples / rate, getChannelData: () => new Float32Array(samples) }; }
  createBufferSource() { const node = new Node(); this.nodes.push(node); return node; }
}
const streams: Array<{ getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> }> = [];
function newStream() { const track = { stop: vi.fn() }; const stream = { getTracks: () => [track] }; streams.push(stream); return stream; }
const labs: VoiceLabSession[] = [];
function fixture() {
  const sockets: Socket[] = [], contexts: Context[] = [], history: Record<string, unknown>[] = [], states: VoiceLabSnapshot[] = [];
  const getUserMedia = vi.fn(async () => newStream() as unknown as MediaStream);
  const createAudioContext = vi.fn(() => { const context = new Context(); contexts.push(context); return context as unknown as AudioContext; });
  const lab = new VoiceLabSession({
    url: "ws://test.invalid/voice", onActivity: event => history.push(event), onState: state => states.push(state),
    blockReason: metadata => previewBlockReason("tenant-1", metadata),
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
    createAudioContext, getUserMedia,
  });
  labs.push(lab);
  const ready = (tenantId = "tenant-1") => sockets.at(-1)!.receive({ type: "voice.lab.ready", tenantId,
    callId: `call-${sockets.length}`, configurationSource: "saved", runtime: "openai-realtime", model: "saved-model", voice: "saved-voice" });
  const start = async () => {
    const pending = lab.startMicrophone();
    ready();
    await pending;
    sockets.at(-1)!.receive({ event: "conversation.opened" });
  };
  const audio = (turn = "turn-1") => {
    sockets.at(-1)!.receive({ type: "audio.chunk", assistantTurnId: turn });
    sockets.at(-1)!.receive(new Int16Array([1, 2, 3]).buffer);
  };
  return { lab, sockets, contexts, history, states, start, ready, audio, getUserMedia, createAudioContext,
    state: () => states.at(-1)!, completions: () => history.filter(event => event.event === "test.completed") };
}
beforeEach(() => { vi.useFakeTimers(); streams.length = 0; });
afterEach(() => { for (const lab of labs.splice(0)) lab.dispose(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("Voice Lab browser lifecycle", () => {
  it("opens the lab without opening a microphone or starting a paid conversation", async () => {
    const f = fixture(); const ready = f.lab.connect(); f.ready(); await ready;
    expect(f.state()).toMatchObject({ phase: "ready", testNumber: 0, connected: true });
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(f.sockets[0]!.sent).toEqual([]);
  });

  it("starts another test without reload, preserving all activity and configuration", async () => {
    const f = fixture(); await f.start();
    for (let i = 0; i < 100; i++) f.sockets[0]!.receive({ event: "activity", detail: i });
    const saved = structuredClone(f.state().configuration);
    f.lab.finish(); const completedHistory = [...f.history];
    expect(f.state()).toMatchObject({ phase: "completed", microphoneActive: false, aiConnected: false });
    expect(f.state().configuration).toEqual(saved);
    await f.start();
    expect(f.state()).toMatchObject({ phase: "active", testNumber: 2, callId: "call-2" });
    expect(f.state().configuration).toEqual({ ...saved, callId: "call-2" });
    expect(f.history.slice(0, completedHistory.length)).toEqual(completedHistory);
    expect(f.history.filter(event => event.event === "activity")).toHaveLength(100);
    expect(f.sockets[1]!.sent).toEqual([{ type: "mic.start", sampleRate: 48_000, channels: 1 }]);
    expect(f.contexts).toHaveLength(2);
  });

  it.each(["conversation.closed", "closed"])("automatically completes on %s, once, without requesting another response", async event => {
    const f = fixture(); await f.start();
    f.sockets[0]!.receive({ event }); f.sockets[0]!.receive({ event }); f.lab.finish();
    expect(f.completions()).toHaveLength(1); expect(f.state().phase).toBe("completed");
    expect(f.sockets[0]!.sent).toEqual([{ type: "mic.start", sampleRate: 48_000, channels: 1 }]);
    expect(f.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(streams[0]!.getTracks()[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it("manual end winning the race with automatic end still finalizes once", async () => {
    const f = fixture(); await f.start(); f.lab.finish(); f.sockets[0]!.receive({ event: "conversation.closed" });
    f.sockets[0]!.dispatchEvent(new Event("close")); f.lab.finish();
    expect(f.completions()).toHaveLength(1);
    expect(f.sockets[0]!.sent.filter((message: any) => message.type === "close")).toHaveLength(1);
    expect(f.sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.sockets[0]!.removed.mock.calls.flat()).toEqual(["open", "message", "close", "error"]);
  });

  it("does not treat an ordinary response, silence, or tool completion as call end", async () => {
    const f = fixture(); await f.start();
    for (const event of ["assistant.response_done", "assistant.audio_completed", "realtime.tool.completed", "user.speech_stopped"]) f.sockets[0]!.receive({ event });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.state().phase).toBe("active"); expect(f.completions()).toHaveLength(0);
  });

  it("stops all turns, the processor, tracks and context; ignores late audio callbacks", async () => {
    const f = fixture(); await f.start(); f.audio("first"); f.audio("second"); await flush();
    const context = f.contexts[0]!; const lateEnd = context.nodes[0]!.onended!;
    f.lab.finish(); await f.start(); const second = f.state(); lateEnd();
    expect(f.state()).toEqual(second);
    for (const node of context.nodes) { expect(node.stop).toHaveBeenCalledTimes(1); expect(node.disconnect).toHaveBeenCalledTimes(1); }
    expect(context.source.disconnect).toHaveBeenCalledTimes(1);
    expect(context.processor.onaudioprocess).toBeNull();
    expect(context.processor.disconnect).toHaveBeenCalledTimes(1);
  });

  it("releases a microphone permission result arriving after end without affecting test two", async () => {
    const f = fixture(); const pendingStream = deferred<MediaStream>();
    f.getUserMedia.mockReturnValueOnce(pendingStream.promise);
    const first = f.lab.startMicrophone(); f.ready(); await flush();
    f.lab.finish(); await f.start(); const second = f.state();
    const lateStream = newStream(); pendingStream.resolve(lateStream as unknown as MediaStream); await first;
    expect(lateStream.getTracks()[0]!.stop).toHaveBeenCalledTimes(1);
    expect(f.state()).toEqual(second); expect(f.sockets[0]!.sent).toEqual([{ type: "close" }]);
  });

  it("does not revive queued audio after end while AudioContext.resume is pending", async () => {
    const f = fixture(); await f.start();
    const context = f.contexts[0]!; const resumed = deferred<void>();
    context.state = "suspended"; context.resume.mockReturnValue(resumed.promise);
    f.audio(); await flush(); f.lab.finish(); resumed.resolve(); await flush();
    expect(context.nodes).toHaveLength(0); expect(f.state().phase).toBe("completed");
  });

  it("does not send a WAV whose file read finishes after its test ends", async () => {
    const f = fixture(); const bytes = deferred<ArrayBuffer>();
    const sent = f.lab.sendFixture({ name: "fixture.wav", arrayBuffer: () => bytes.promise });
    f.ready(); await flush(); f.lab.finish(); await f.start();
    bytes.resolve(new ArrayBuffer(8)); await sent;
    expect(f.sockets[0]!.sent).toEqual([{ type: "close" }]);
    expect(f.sockets[1]!.sent).toEqual([{ type: "mic.start", sampleRate: 48_000, channels: 1 }]);
  });

  it("acknowledges farewell drain only after all queued audio has actually ended", async () => {
    const f = fixture(); await f.start(); f.audio();
    f.sockets[0]!.receive({ type: "playback.finish", requestId: "drain-1", assistantTurnId: "turn-1" });
    await flush();
    expect(f.sockets[0]!.sent).not.toContainEqual(expect.objectContaining({ type: "playback.idle" }));
    f.contexts[0]!.nodes[0]!.end();
    expect(f.sockets[0]!.sent.at(-1)).toEqual({ type: "playback.idle", requestId: "drain-1", assistantTurnId: "turn-1" });
    expect(f.state().phase).toBe("active");
  });

  it("barge-in invalidates queued playback and its stale drain acknowledgment", async () => {
    const f = fixture(); await f.start(); f.audio();
    f.sockets[0]!.receive({ type: "playback.finish", requestId: "drain", assistantTurnId: "turn-1" });
    f.sockets[0]!.receive({ type: "playback.clear", requestId: "interrupt" }); await flush();
    expect(f.contexts[0]!.nodes).toHaveLength(0);
    expect(f.sockets[0]!.sent.at(-1)).toMatchObject({ type: "playback.cleared", requestId: "interrupt", active: false });
    expect(f.sockets[0]!.sent).not.toContainEqual(expect.objectContaining({ type: "playback.idle" }));
    expect(f.state().phase).toBe("active");
  });

  it("pause/resume keeps the same call and avoids duplicate microphone acquisition", async () => {
    const f = fixture(); await f.start(); await f.lab.startMicrophone();
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    f.lab.pauseMicrophone(); await f.lab.startMicrophone();
    expect(f.sockets).toHaveLength(1); expect(f.state().testNumber).toBe(1);
    expect(f.completions()).toHaveLength(0); expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("a disconnect during startup cleans up, then allows retry", async () => {
    const f = fixture(); const pending = f.lab.startMicrophone(); f.sockets[0]!.close(); await pending;
    expect(f.state().phase).toBe("error"); expect(f.getUserMedia).not.toHaveBeenCalled();
    await f.start(); expect(f.state().phase).toBe("active"); expect(vi.getTimerCount()).toBe(0);
  });

  it("connection timeout cleans up and does not prevent retry", async () => {
    const f = fixture(); const pending = f.lab.startMicrophone();
    await vi.advanceTimersByTimeAsync(10_000); await pending;
    expect(f.state().completionReason).toBe("connection_timeout");
    await f.start(); expect(f.state().phase).toBe("active");
  });

  it("rechecks tenant/configuration readiness on every new connection", async () => {
    const f = fixture(); await f.start(); f.lab.finish();
    const second = f.lab.startMicrophone(); f.ready("other-tenant"); await second;
    expect(f.getUserMedia).toHaveBeenCalledTimes(1); expect(f.sockets[1]!.sent).toEqual([]);
    expect(f.history.at(-1)).toMatchObject({ event: "error", error: expect.stringContaining("different tenant") });
  });

  it("unmount prevents reconnect and stops late microphone permission results", async () => {
    const f = fixture(); const pendingStream = deferred<MediaStream>();
    f.getUserMedia.mockReturnValueOnce(pendingStream.promise);
    const pending = f.lab.startMicrophone(); f.ready(); await flush(); f.lab.dispose();
    const lateStream = newStream(); pendingStream.resolve(lateStream as unknown as MediaStream); await pending;
    await f.lab.startMicrophone(); await f.lab.connect();
    expect(lateStream.getTracks()[0]!.stop).toHaveBeenCalledTimes(1); expect(f.sockets).toHaveLength(1);
  });

  it("microphone errors terminate cleanly, preserving the error for a retry", async () => {
    const f = fixture(); f.getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));
    const first = f.lab.startMicrophone(); f.ready(); await first;
    expect(f.state().phase).toBe("error"); expect(f.history).toContainEqual(expect.objectContaining({ error: "Permission denied" }));
    await f.start(); expect(f.state().phase).toBe("active");
  });
});
