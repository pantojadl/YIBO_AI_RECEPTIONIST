import { setTimeout as delay } from "node:timers/promises";
import type { RawData, WebSocket } from "ws";
import type { YiboApplication } from "../../src/bootstrap/build-application.js";
import type { CallRepository } from "../../src/modules/calls/index.js";
import type {
  AudioFrame,
  ConversationRuntimeEvent,
  ConversationTransport,
} from "../../src/modules/conversation/index.js";
import {
  decodeWav,
  floatAudioToRealtimeFrame,
  splitRealtimeFrame,
} from "../../src/modules/voice/index.js";

interface HarnessOptions {
  app: Pick<YiboApplication, "tenantId" | "config" | "agentConfiguration" | "ids" | "calls" | "registerCallMedia">;
  callRepository: Pick<CallRepository, "findByCallId">;
  calledNumber: string;
  transcriptEnabled: boolean;
  audioDebug: boolean;
}

export function attachHarness(socket: WebSocket, options: HarnessOptions): void {
  const { app, callRepository, calledNumber, transcriptEnabled, audioDebug } = options;
  void app.agentConfiguration.get(app.tenantId).then((configuration) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type: "voice.lab.ready", callId, tenantId: app.tenantId,
      runtime: app.config.runtime, model: configuration?.conversation.model,
      voice: configuration?.audio.voice, configurationSource: "saved",
    }));
  }).catch(() => { if (socket.readyState === socket.OPEN) socket.close(1011, "Configuration unavailable"); });
  const callId = app.ids.generate("call");
  const inbound = new AudioQueue();
  let conversationStarted = false;
  let ended = false;
  let runtimeFailed = false;
  let releaseMedia: (() => void) | undefined;
  const abort = new AbortController();
  const idleListeners = new Set<() => void>();
  let pendingDrain: { requestId: string; assistantTurnId: string } | undefined;
  let starting: Promise<void> | undefined;
  let inputSampleRate = 48_000;
  let inputChannels = 1;
  let nextBinaryIsWav = false;
  let inboundFrames = 0;
  let outboundFrames = 0;
  let lastAssistantTurnId: string | undefined;
  type PlaybackPosition = { assistantTurnId: string; audioEndMs: number };
  const playbackAcks = new Map<string, (position: PlaybackPosition | undefined) => void>();

  const log = (event: string, metadata: Record<string, unknown> = {}) => {
    const record = { callId, timestamp: new Date().toISOString(), event, ...metadata };
    console.log(JSON.stringify(record));
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(record));
  };

  const interruptLocalPlayback = async (): Promise<PlaybackPosition | undefined> => {
    if (!lastAssistantTurnId || socket.readyState !== socket.OPEN) return undefined;
    const requestId = app.ids.generate("idempotency");
    const fallback = { assistantTurnId: lastAssistantTurnId, audioEndMs: 0 };
    const position = await new Promise<PlaybackPosition | undefined>((resolve) => {
      const timeout = setTimeout(() => {
        playbackAcks.delete(requestId);
        resolve(fallback);
      }, 500);
      playbackAcks.set(requestId, (value) => {
        clearTimeout(timeout);
        playbackAcks.delete(requestId);
        resolve(value);
      });
      socket.send(JSON.stringify({ type: "playback.clear", requestId }));
    });
    if (position) log("playback.interrupted", position);
    return position;
  };

  const ensureConversation = async (): Promise<void> => {
    if (ended) return;
    if (conversationStarted) return;
    if (starting) return starting;
    starting = startConversation();
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  };

  const startConversation = async (): Promise<void> => {
    const transport: ConversationTransport = {
      inboundAudio: inbound,
      observeEvent: (event) => {
        if (event.type === "error" && !event.retryable) runtimeFailed = true;
        observeRuntimeEvent(event, log, transcriptEnabled);
      },
      outboundAudio: {
        write: async (frame, assistantTurnId) => {
          if (ended) return;
          pendingDrain = undefined;
          outboundFrames += 1;
          lastAssistantTurnId = assistantTurnId;
          if (audioDebug || outboundFrames === 1) {
            log(outboundFrames === 1 ? "assistant.audio_started" : "audio.out", {
              bytes: frame.data.byteLength,
              frames: outboundFrames,
              ...(audioDebug ? { debug: true } : {}),
            });
          }
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "audio.chunk", assistantTurnId, bytes: frame.data.byteLength }));
            socket.send(frame.data, { binary: true });
          }
        },
        interrupt: interruptLocalPlayback,
        onPlaybackIdle: listener => { idleListeners.add(listener); return () => { idleListeners.delete(listener); }; },
        finishAudio: assistantTurnId => {
          if (ended || socket.readyState !== socket.OPEN) return;
          pendingDrain = { assistantTurnId, requestId: app.ids.generate("idempotency") };
          socket.send(JSON.stringify({ type: "playback.finish", ...pendingDrain }));
        },
      },
      // Do not await CALL_HUNG_UP here: the orchestrator is already closing this transport.
      close: async () => { finalize(runtimeFailed ? "runtime_failed" : "conversation_ended", false); },
    };
    releaseMedia = app.registerCallMedia(callId, transport);
    await app.calls.handleTelephonyEvent({
      type: "INCOMING_CALL",
      callId,
      from: "+529990000001",
      to: calledNumber,
      occurredAt: new Date().toISOString(),
    });
    if (ended) return;
    const call = await callRepository.findByCallId(callId);
    if (ended) return;
    if (call?.state !== "IN_CONVERSATION") {
      throw new Error("OpenAI Realtime conversation could not start. Check the voice-server error above.");
    }
    conversationStarted = true;
    log("conversation.opened");
  };

  const onMessage = (raw: RawData, binary: boolean) => {
    if (ended) return;
    void (async () => {
      try {
        if (!binary) {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type === "playback.cleared") {
            const requestId = typeof message.requestId === "string" ? message.requestId : "";
            const assistantTurnId = typeof message.assistantTurnId === "string" ? message.assistantTurnId : "";
            const audioEndMs = typeof message.audioEndMs === "number" ? message.audioEndMs : 0;
            if (requestId) {
              playbackAcks.get(requestId)?.(message.active === false || !assistantTurnId
                ? undefined
                : { assistantTurnId, audioEndMs });
            }
          } else if (message.type === "playback.idle") {
            if (pendingDrain && message.requestId === pendingDrain.requestId && message.assistantTurnId === pendingDrain.assistantTurnId) {
              pendingDrain = undefined;
              for (const listener of idleListeners) listener();
            }
          } else if (message.type === "mic.start") {
            inputSampleRate = positiveNumber(message.sampleRate, "sampleRate");
            inputChannels = positiveNumber(message.channels, "channels");
            await ensureConversation();
            if (ended) return;
            log("microphone.started", { sampleRate: inputSampleRate, channels: inputChannels });
          } else if (message.type === "fixture.next") {
            nextBinaryIsWav = true;
            await ensureConversation();
            if (ended) return;
            log("fixture.ready", { name: typeof message.name === "string" ? message.name : "fixture.wav" });
          } else if (message.type === "interrupt") {
            if (!conversationStarted) return;
            const position = await interruptLocalPlayback();
            if (ended) return;
            await app.calls.interrupt(callId, position);
            log("conversation.interrupted");
          } else if (message.type === "close") {
            finalize("manual");
          }
          return;
        }
        await ensureConversation();
        if (ended) return;
        const bytes = raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : Array.isArray(raw)
            ? new Uint8Array(Buffer.concat(raw))
            : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        if (nextBinaryIsWav) {
          nextBinaryIsWav = false;
          const decoded = decodeWav(bytes);
          const frames = splitRealtimeFrame(floatAudioToRealtimeFrame(decoded));
          log("fixture.decoded", {
            bytes: bytes.byteLength,
            frames: frames.length,
            sampleRate: decoded.sampleRate,
            channels: decoded.channels,
          });
          for (const frame of frames) {
            if (ended) break;
            pushInbound(frame);
            await delay(20, undefined, { signal: abort.signal });
          }
        } else {
          const copy = bytes.slice();
          if (copy.byteLength % 4 !== 0) throw new Error("Microphone frame is not Float32 audio");
          const frame = floatAudioToRealtimeFrame({
            samples: new Float32Array(copy.buffer),
            sampleRate: inputSampleRate,
            channels: inputChannels,
          });
          pushInbound(frame);
        }
      } catch (error) {
        if (ended) return;
        log("error", { error: errorMessage(error) });
        finalize("harness_failed");
      }
    })();
  };
  socket.on("message", onMessage);

  socket.on("error", () => finalize("websocket_failed"));
  socket.on("close", () => {
    finalize("disconnected");
    console.log(JSON.stringify({ callId, timestamp: new Date().toISOString(), event: "harness.disconnected" }));
  });

  function finalize(reason: string, notifyCall = true): void {
    if (ended) return;
    ended = true;
    abort.abort();
    inbound.end();
    nextBinaryIsWav = false;
    pendingDrain = undefined;
    idleListeners.clear();
    for (const resolve of [...playbackAcks.values()]) resolve(undefined);
    playbackAcks.clear();
    releaseMedia?.();
    releaseMedia = undefined;
    socket.off("message", onMessage);
    log("conversation.closed", { reason, failed: reason.endsWith("failed") });
    if (socket.readyState === socket.OPEN) socket.close(1000, "Test completed");
    // The orchestrator waits for a pending INCOMING_CALL before shutting it down.
    // Always notify it on disconnect, even if startup has not returned yet.
    if (notifyCall) void app.calls.handleTelephonyEvent({
      type: "CALL_HUNG_UP", callId, occurredAt: new Date().toISOString(),
    }).catch(error => log("cleanup.failed", { error: errorMessage(error) }));
  }

  function pushInbound(frame: AudioFrame): void {
    if (ended) return;
    inboundFrames += 1;
    if (audioDebug || inboundFrames === 1) {
      log("audio.in", { bytes: frame.data.byteLength, frames: inboundFrames, ...(audioDebug ? { debug: true } : {}) });
    }
    inbound.push(frame);
  }
}

function observeRuntimeEvent(
  event: ConversationRuntimeEvent,
  log: (event: string, metadata?: Record<string, unknown>) => void,
  transcriptEnabled: boolean,
): void {
  switch (event.type) {
    case "audio.delta":
      return;
    case "assistant.transcript":
      log(event.type, transcriptEnabled ? { final: event.final, transcript: event.text } : { final: event.final });
      return;
    case "tool.call":
      log("realtime.tool.requested", { toolCallId: event.toolCallId, name: event.name });
      return;
    case "tool.execution":
      log(`realtime.tool.${event.phase}`, { toolCallId: event.toolCallId, name: event.name });
      return;
    case "error":
      log(event.type, { code: event.code, retryable: event.retryable, error: event.message });
      return;
    case "usage":
      log(event.type, { ...event });
      return;
    default:
      log(event.type);
  }
}

class AudioQueue implements AsyncIterable<AudioFrame> {
  private readonly values: AudioFrame[] = [];
  private readonly readers: Array<(value: IteratorResult<AudioFrame>) => void> = [];
  private ended = false;

  push(frame: AudioFrame): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader) reader({ value: frame, done: false });
    else this.values.push(frame);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.values.length = 0;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioFrame> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unexpected harness error";
