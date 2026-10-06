import { operationalLog } from "../../../shared/observability/operational-log.js";
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import type { RealtimeClientEvent, RealtimeServerEvent } from "openai/resources/realtime/realtime";
import type { ConversationToolName } from "../ports/conversation-runtime-port.js";
import type {
  ConversationRuntimeEvent,
  AssistantPlaybackPosition,
  ConversationRuntimePort,
  ConversationRuntimeSession,
  OpenConversationInput,
  ToolResultEnvelope,
} from "../ports/conversation-runtime-port.js";
import type { AudioFrame } from "../ports/conversation-runtime-port.js";
import { REALTIME_AUDIO_TRANSPORT } from "../domain/realtime-transport-profile.js";
import { buildRealtimeSessionUpdate } from "./realtime-session-payload.js";

export interface OpenAIRealtimeAdapterOptions {
  apiKey: string;
  /** @deprecated Session model comes from AgentConfiguration. */
  model?: string;
  /** @deprecated Session output limit comes from AgentConfiguration. */
  maxOutputTokens?: number;
  /** @deprecated Test-only fallback. Product channels resolve their modality from trusted server context. */
  mode?: "text" | "audio";
  /** @deprecated Session VAD comes from AgentConfiguration. */
  turnDetection?: ServerTurnDetectionOptions;
  logger?: RealtimeErrorLogger;
  connectionFactory?: RealtimeConnectionFactory;
}

export interface ServerTurnDetectionOptions {
  type?: "server_vad";
  threshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
}

export interface RealtimeErrorLogger {
  info?(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: { code?: string; error?: string }): void;
}

export interface RealtimeConnectionFactory {
  connect(input: { apiKey: string; model: string }): Promise<RealtimeConnection>;
}

export interface RealtimeConnection {
  send(event: unknown): void;
  close(): void;
  onEvent(handler: (event: unknown) => void): void;
  onError(handler: (error: { message: string; code?: string }) => void): void;
  onClose(handler: (reason?: string) => void): void;
}

export class OpenAIRealtimeAdapter implements ConversationRuntimePort {
  private readonly fallbackMode: "text" | "audio";
  private readonly logger: RealtimeErrorLogger;
  private readonly connectionFactory: RealtimeConnectionFactory;

  constructor(private readonly options: OpenAIRealtimeAdapterOptions) {
    if (!options.apiKey.trim()) throw new Error("OpenAIRealtimeAdapter requires an API key");
    this.fallbackMode = options.mode ?? "audio";
    this.logger = options.logger ?? consoleLogger;
    this.connectionFactory = options.connectionFactory ?? sdkConnectionFactory;
  }

  async openSession(input: OpenConversationInput): Promise<ConversationRuntimeSession> {
    const model = input.agent.conversation.model;
    const mode = input.agent.channel ? REALTIME_AUDIO_TRANSPORT.modality : this.fallbackMode;
    const sessionUpdate = buildRealtimeSessionUpdate(input.agent, mode);
    let connection: RealtimeConnection;
    this.logger.info?.("OpenAI Realtime connection starting", { model, mode });
    try {
      connection = await this.connectionFactory.connect({
        apiKey: this.options.apiKey,
        model,
      });
    } catch (error) {
      this.logger.error("OpenAI Realtime WebSocket connection failed", connectionErrorDetails(error));
      throw error;
    }
    this.logger.info?.("OpenAI Realtime connection established", { model, mode });
    const session = new OpenAIRealtimeSession(connection, input, this.logger, mode);
    connection.send(sessionUpdate);
    if (input.agent.behavior.greeting.mode === "automatic") {
      connection.send({
        type: "response.create",
        response: {
          instructions: `Use the language and regional pronunciation required by locale ${JSON.stringify(input.agent.locale)}. Say exactly this greeting and add nothing else: ${JSON.stringify(input.agent.behavior.greeting.message)}.`,
        },
      });
      this.logger.info?.("OpenAI Realtime automatic greeting requested");
    }
    this.logger.info?.("OpenAI Realtime session.update sent", {
      model,
      mode,
      outputAudioFormat: mode === "audio"
        ? `${REALTIME_AUDIO_TRANSPORT.codec}/${REALTIME_AUDIO_TRANSPORT.sampleRate}/mono`
        : undefined,
      turnDetection: mode === "audio" ? input.agent.audio.turnDetection : undefined,
      noiseReduction: mode === "audio" ? input.agent.audio.noiseReduction : undefined,
      tracing: input.agent.conversation.tracing,
      truncation: input.agent.conversation.truncation.mode,
    });
    return session;
  }
}

class OpenAIRealtimeSession implements ConversationRuntimeSession {
  private readonly queue = new AsyncEventQueue<ConversationRuntimeEvent>();
  private readonly allowedTools: Set<string>;
  private closed = false;
  private endingCall = false;
  private suppressedEndResponseId?: string;
  private readonly audioContentIndexes = new Map<string, number>();
  private readonly truncatedAssistantTurns = new Set<string>();
  private state: RealtimeTurnState = "listening";
  private activeResponseId?: string;
  private toolResponsePending = false;
  private responseRequested = false;
  private readonly deliveredToolResults = new Set<string>();
  private readonly automaticTurnResponse: boolean;
  private inputAudioFrames = 0;
  private callerIsSpeaking = false;
  private readonly behavior: OpenConversationInput["agent"]["behavior"];
  private readonly automaticSilenceResponse: boolean;
  private silencePromptCount = 0;
  private suppressNextSilenceResponse = false;

  constructor(
    private readonly connection: RealtimeConnection,
    input: OpenConversationInput,
    private readonly logger: RealtimeErrorLogger,
    private readonly mode: "text" | "audio",
  ) {
    this.allowedTools = new Set(input.agent.tools.map((tool) => tool.name));
    this.behavior = structuredClone(input.agent.behavior);
    this.automaticTurnResponse = input.agent.audio.turnDetection.type !== "manual"
      && input.agent.audio.turnDetection.createResponse;
    this.automaticSilenceResponse = input.agent.audio.turnDetection.type === "server_vad"
      && input.agent.audio.turnDetection.createResponse;
    connection.onEvent((event) => this.handleEvent(event));
    connection.onError((error) => this.handleError(error));
    connection.onClose((reason) => this.finish(reason));
  }

  async sendText(text: string): Promise<void> {
    this.endingCall = false;
    const normalized = text.trim();
    if (!normalized) throw new Error("Conversation text must not be empty");
    this.assertOpen();
    this.connection.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });
    this.logger.info?.("OpenAI Realtime response.create sent", { source: "text_turn" });
    this.responseRequested = true;
    this.connection.send({ type: "response.create" });
    this.setState("thinking", { source: "text_turn" });
  }

  async requestResponse(instructions: string): Promise<void> {
    this.assertOpen();
    const normalized = instructions.trim();
    if (!normalized) throw new Error("Conversation instructions must not be empty");
    this.endingCall = false;
    this.responseRequested = true;
    this.connection.send({ type: "response.create", response: { instructions: normalized } });
    this.logger.info?.("OpenAI Realtime response.create sent", { source: "spend_limit" });
    this.setState("thinking", { source: "spend_limit" });
  }

  async sendAudio(frame: AudioFrame): Promise<void> {
    this.assertOpen();
    if (this.mode !== "audio") {
      throw new Error("OpenAIRealtimeAdapter is configured for text-only input and output");
    }
    if (frame.codec !== REALTIME_AUDIO_TRANSPORT.codec
      || frame.sampleRate !== REALTIME_AUDIO_TRANSPORT.sampleRate
      || frame.channels !== REALTIME_AUDIO_TRANSPORT.channels) {
      throw new Error("OpenAI Realtime audio requires mono pcm_s16le at 24000 Hz");
    }
    this.connection.send({
      type: "input_audio_buffer.append",
      audio: Buffer.from(frame.data).toString("base64"),
    });
    this.inputAudioFrames += 1;
    if (process.env.YIBO_VOICE_DEBUG === "1" || this.inputAudioFrames === 1) {
      this.logger.info?.("OpenAI Realtime input_audio_buffer.append sent", {
        bytes: frame.data.byteLength,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        frames: this.inputAudioFrames,
        ...(process.env.YIBO_VOICE_DEBUG === "1" ? { debug: true } : {}),
      });
    }
  }

  async sendToolResult(result: ToolResultEnvelope, options?: { requestResponse: boolean }): Promise<void> {
    this.assertOpen();
    if (this.deliveredToolResults.has(result.toolCallId)) return;
    this.connection.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: result.toolCallId,
        output: JSON.stringify(result.ok
          ? { ok: true, data: result.data }
          : { ok: false, error: result.error }),
      },
    });
    this.deliveredToolResults.add(result.toolCallId);
    if (options?.requestResponse === false) { this.endingCall = true; return; }
    this.endingCall = false;
    this.toolResponsePending = true;
    this.flushToolResponse();
  }

  private flushToolResponse(): void {
    if (!this.toolResponsePending || this.callerIsSpeaking || this.activeResponseId || this.responseRequested) return;
    this.toolResponsePending = false;
    this.responseRequested = true;
    this.connection.send({ type: "response.create" });
    this.logger.info?.("OpenAI Realtime response.create sent", { source: "tool_result" });
    this.setState("thinking", { source: "tool_result" });
  }

  async interrupt(position?: AssistantPlaybackPosition): Promise<void> {
    this.endingCall = false;
    this.assertOpen();
    // With interrupt_response=true, OpenAI cancels the response on VAD speech start.
    // We only synchronize the amount of audio the caller actually heard.
    if (!position || this.truncatedAssistantTurns.has(position.assistantTurnId)) return;
    this.truncatedAssistantTurns.add(position.assistantTurnId);
    this.setState("interrupted", { assistantTurnId: position.assistantTurnId, source: "local_playback_clear" });
    this.connection.send({
      type: "conversation.item.truncate",
      item_id: position.assistantTurnId,
      content_index: this.audioContentIndexes.get(position.assistantTurnId) ?? 0,
      audio_end_ms: Math.max(0, Math.round(position.audioEndMs)),
    });
    this.logger.info?.("OpenAI Realtime assistant audio truncated", {
      assistantTurnId: position.assistantTurnId,
      audioEndMs: Math.max(0, Math.round(position.audioEndMs)),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logger.info?.("OpenAI Realtime connection closing", { reason: "client_closed" });
    this.connection.close();
    this.queue.push({ type: "closed", reason: "client_closed" });
    this.queue.end();
  }

  events(): AsyncIterable<ConversationRuntimeEvent> {
    return this.queue;
  }

  private handleEvent(value: unknown): void {
    if (this.closed || !isRecord(value) || typeof value.type !== "string") return;
    if (this.suppressedEndResponseId && value.response_id === this.suppressedEndResponseId) return;
    this.logger.info?.("OpenAI Realtime event received", eventLogDetails(value));
    switch (value.type) {
      case "session.created":
        this.logger.info?.("OpenAI Realtime session created", sessionLogDetails(value));
        return;
      case "session.updated":
        this.logger.info?.("OpenAI Realtime session configuration accepted", sessionLogDetails(value));
        return;
      case "input_audio_buffer.committed":
        this.logger.info?.("OpenAI Realtime input audio buffer committed", eventLogDetails(value));
        return;
      case "input_audio_buffer.timeout_triggered":
        this.logger.info?.("OpenAI Realtime idle timeout triggered", eventLogDetails(value));
        this.queue.push({ type: "silence.timeout" });
        if (!this.automaticSilenceResponse) return;
        if (this.silencePromptCount >= this.behavior.silence.maxPrompts) {
          this.suppressNextSilenceResponse = true;
          this.logger.info?.("OpenAI Realtime silence prompt limit reached", {
            maxPrompts: this.behavior.silence.maxPrompts,
          });
        } else {
          this.silencePromptCount += 1;
        }
        return;
      case "response.output_text.delta":
        if (typeof value.delta === "string") {
          this.queue.push({ type: "assistant.transcript", text: value.delta, final: false });
        }
        return;
      case "response.output_text.done":
        if (typeof value.text === "string") {
          this.queue.push({ type: "assistant.transcript", text: value.text, final: true });
        }
        return;
      case "response.output_audio.delta":
        if (typeof value.delta === "string" && typeof value.item_id === "string") {
          if (typeof value.content_index === "number") {
            this.audioContentIndexes.set(value.item_id, value.content_index);
          }
          this.queue.push({
            type: "audio.delta",
            assistantTurnId: value.item_id,
            frame: {
              data: Buffer.from(value.delta, "base64"),
              codec: REALTIME_AUDIO_TRANSPORT.codec,
              sampleRate: REALTIME_AUDIO_TRANSPORT.sampleRate,
              channels: REALTIME_AUDIO_TRANSPORT.channels,
            },
          });
          this.setState("assistant_speaking", { assistantTurnId: value.item_id });
        }
        return;
      case "response.output_audio.done":
        this.logger.info?.("OpenAI Realtime assistant audio completed", eventLogDetails(value));
        this.queue.push({ type: "assistant.audio_completed", ...(typeof value.item_id === "string" ? { assistantTurnId: value.item_id } : {}) });
        return;
      case "response.output_audio_transcript.delta":
        if (typeof value.delta === "string") {
          this.queue.push({ type: "assistant.transcript", text: value.delta, final: false });
        }
        return;
      case "response.output_audio_transcript.done":
        if (typeof value.transcript === "string") {
          this.queue.push({ type: "assistant.transcript", text: value.transcript, final: true });
        }
        return;
      case "response.function_call_arguments.done":
        this.handleToolCall(value);
        return;
      case "input_audio_buffer.speech_started":
        this.endingCall = false;
        this.logger.info?.("OpenAI Realtime speech started", eventLogDetails(value));
        this.callerIsSpeaking = true;
        this.silencePromptCount = 0;
        this.suppressNextSilenceResponse = false;
        this.setState("user_speaking", { source: "server_vad" });
        this.queue.push({ type: "user.speech_started" });
        return;
      case "input_audio_buffer.speech_stopped":
        this.logger.info?.("OpenAI Realtime speech stopped", eventLogDetails(value));
        this.callerIsSpeaking = false;
        this.setState("thinking", { source: "server_vad" });
        this.queue.push({ type: "user.speech_stopped" });
        if (!this.automaticTurnResponse) this.flushToolResponse();
        return;
      case "response.created":
        if (this.endingCall) {
          this.suppressedEndResponseId = isRecord(value.response) && typeof value.response.id === "string" ? value.response.id : undefined;
          this.connection.send({ type: "response.cancel" });
          return;
        }
        this.logger.info?.("OpenAI Realtime response created", eventLogDetails(value));
        this.activeResponseId = responseId(value);
        // A server-created turn consumes queued results; a locally requested
        // turn may have been requested before a later result was delivered.
        if (!this.responseRequested) this.toolResponsePending = false;
        this.responseRequested = false;
        if (this.suppressNextSilenceResponse) {
          this.suppressNextSilenceResponse = false;
          this.connection.send({ type: "response.cancel" });
          this.logger.info?.("OpenAI Realtime silence response cancelled", {
            maxPrompts: this.behavior.silence.maxPrompts,
          });
        }
        this.setState("thinking", { ...(this.activeResponseId ? { responseId: this.activeResponseId } : {}) });
        this.queue.push({ type: "assistant.response_created", ...(this.activeResponseId ? { responseId: this.activeResponseId } : {}) });
        return;
      case "response.done":
        if (isRecord(value.response) && value.response.id === this.suppressedEndResponseId && this.suppressedEndResponseId) {
          this.suppressedEndResponseId = undefined;
          return;
        }
        this.logger.info?.("OpenAI Realtime response done", eventLogDetails(value));
        const status = responseStatus(value);
        if (status === "cancelled") this.logger.info?.("OpenAI Realtime response cancelled", eventLogDetails(value));
        this.activeResponseId = undefined;
        this.responseRequested = false;
        // A cancellation can arrive after the caller has already started speaking.
        // Preserve that fact so a late tool result cannot start a competing response.
        this.setState(this.callerIsSpeaking ? "user_speaking" : "listening", { reason: status ?? "done" });
        this.logger.info?.("OpenAI Realtime response state reset", { reason: status ?? "done" });
        this.queue.push({ type: "assistant.response_done", ...(status ? { status } : {}) });
        this.handleUsage(value.response);
        if (!(this.callerIsSpeaking && this.automaticTurnResponse)) this.flushToolResponse();
        return;
      case "error":
        this.handleProviderEventError(value.error);
        return;
    }
  }

  private handleToolCall(event: Record<string, unknown>): void {
    if (typeof event.call_id !== "string" || typeof event.name !== "string" || typeof event.arguments !== "string") {
      this.emitError("INVALID_TOOL_CALL", "The runtime returned an incomplete tool call", false);
      return;
    }
    if (!this.allowedTools.has(event.name)) {
      this.emitError("UNKNOWN_TOOL", `The runtime requested an unknown tool: ${event.name}`, false);
      return;
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(event.arguments);
    } catch {
      this.emitError("INVALID_TOOL_ARGUMENTS", "The runtime returned invalid JSON tool arguments", false);
      return;
    }
    this.queue.push({
      type: "tool.call",
      toolCallId: event.call_id,
      name: event.name as ConversationToolName,
      arguments: argumentsValue,
    });
  }

  private handleUsage(response: unknown): void {
    if (!isRecord(response) || !isRecord(response.usage)) return;
    const usage = response.usage;
    const inputDetails = isRecord(usage.input_token_details) ? usage.input_token_details : {};
    const outputDetails = isRecord(usage.output_token_details) ? usage.output_token_details : {};
    const cachedDetails = isRecord(inputDetails.cached_tokens_details) ? inputDetails.cached_tokens_details : {};
    const output = Array.isArray(response.output) ? response.output : [];
    this.queue.push({
      type: "usage",
      ...(number(usage.input_tokens) ? { inputTokens: usage.input_tokens as number } : {}),
      ...(number(usage.output_tokens) ? { outputTokens: usage.output_tokens as number } : {}),
      ...(number(usage.total_tokens) ? { totalTokens: usage.total_tokens as number } : {}),
      ...(number(inputDetails.text_tokens) ? { inputTextTokens: inputDetails.text_tokens as number } : {}),
      ...(number(outputDetails.text_tokens) ? { outputTextTokens: outputDetails.text_tokens as number } : {}),
      ...(number(inputDetails.audio_tokens) ? { inputAudioTokens: inputDetails.audio_tokens as number } : {}),
      ...(number(outputDetails.audio_tokens) ? { outputAudioTokens: outputDetails.audio_tokens as number } : {}),
      ...(number(inputDetails.cached_tokens) ? { cachedInputTokens: inputDetails.cached_tokens as number } : {}),
      ...(number(cachedDetails.text_tokens) ? { cachedInputTextTokens: cachedDetails.text_tokens as number } : {}),
      ...(number(cachedDetails.audio_tokens) ? { cachedInputAudioTokens: cachedDetails.audio_tokens as number } : {}),
      ...(number(inputDetails.audio_tokens) ? { inputAudioMs: (inputDetails.audio_tokens as number) * 100 } : {}),
      ...(number(outputDetails.audio_tokens) ? { outputAudioMs: (outputDetails.audio_tokens as number) * 50 } : {}),
      toolCalls: output.filter((item) => isRecord(item) && item.type === "function_call").length,
    });
  }

  private handleProviderEventError(value: unknown): void {
    const error = isRecord(value) ? value : {};
    const code = typeof error.code === "string" ? error.code : "REALTIME_ERROR";
    const message = typeof error.message === "string" ? error.message : "Realtime session error";
    this.logAndEmit(code, message, true);
  }

  private handleError(error: { message: string; code?: string }): void {
    this.logAndEmit(error.code ?? "WEBSOCKET_ERROR", error.message, true);
  }

  private logAndEmit(code: string, message: string, retryable: boolean): void {
    this.logger.error("OpenAI Realtime WebSocket error", { code, error: redactCredential(message) });
    this.emitError(code, message, retryable);
  }

  private emitError(code: string, message: string, retryable: boolean): void {
    if (!this.closed) this.queue.push({ type: "error", code, message, retryable });
  }

  private finish(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.logger.info?.("OpenAI Realtime connection closed", { ...(reason ? { reason } : {}) });
    this.queue.push({ type: "closed", ...(reason ? { reason } : {}) });
    this.queue.end();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Conversation runtime session is closed");
  }

  private setState(next: RealtimeTurnState, details: Record<string, unknown> = {}): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.logger.info?.("OpenAI Realtime turn state changed", { from: previous, to: next, ...details });
  }
}

type RealtimeTurnState = "listening" | "user_speaking" | "thinking" | "assistant_speaking" | "interrupted";

class SDKRealtimeConnection implements RealtimeConnection {
  private readonly realtime: OpenAIRealtimeWS;
  private readonly opened: Promise<void>;
  private eventHandler?: (event: unknown) => void;
  private readonly pendingEvents: unknown[] = [];
  private errorHandler?: (error: { message: string; code?: string }) => void;
  private readonly pendingErrors: Array<{ message: string; code?: string }> = [];

  constructor(input: { apiKey: string; model: string }) {
    const client = new OpenAI({ apiKey: input.apiKey });
    this.realtime = new OpenAIRealtimeWS({ model: input.model, options: { handshakeTimeout: 10_000 } }, client);
    // Attach before awaiting open: the SDK otherwise reports startup errors as
    // unhandled promise rejections even when the raw socket has an error listener.
    this.realtime.on("error", (error) => {
      // Provider error events already travel through the event handler.
      if (error.error) return;
      const details = { message: error.message };
      if (this.errorHandler) this.errorHandler(details);
      else this.pendingErrors.push(details);
    });
    this.opened = new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Realtime connection closed before opening")); };
      const cleanup = () => {
        this.realtime.socket.off("open", onOpen);
        this.realtime.socket.off("error", onError);
        this.realtime.socket.off("close", onClose);
      };
      this.realtime.socket.once("open", onOpen);
      this.realtime.socket.once("error", onError);
      this.realtime.socket.once("close", onClose);
    });
    this.realtime.on("event", (event: RealtimeServerEvent) => {
      if (this.eventHandler) this.eventHandler(event);
      else this.pendingEvents.push(event);
    });
  }

  async waitUntilOpen(): Promise<void> {
    await this.opened;
  }

  send(event: unknown): void {
    this.realtime.send(event as RealtimeClientEvent);
  }

  close(): void {
    this.realtime.close();
  }

  onEvent(handler: (event: unknown) => void): void {
    this.eventHandler = handler;
    for (const event of this.pendingEvents.splice(0)) handler(event);
  }

  onError(handler: (error: { message: string; code?: string }) => void): void {
    this.errorHandler = handler;
    for (const error of this.pendingErrors.splice(0)) handler(error);
  }

  onClose(handler: (reason?: string) => void): void {
    this.realtime.socket.on("close", (_code, reason) => handler(reason.toString() || undefined));
  }
}

const sdkConnectionFactory: RealtimeConnectionFactory = {
  connect: async (input) => {
    const connection = new SDKRealtimeConnection(input);
    await connection.waitUntilOpen();
    return connection;
  },
};

const consoleLogger: RealtimeErrorLogger = {
  info: (message, details) => {
    if (message === "OpenAI Realtime event received" || message === "OpenAI Realtime input_audio_buffer.append sent") return;
    operationalLog(`realtime.${message.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, details);
  },
  error: (_message, details) => operationalLog("realtime.error", details),
};

function connectionErrorDetails(error: unknown): { code: string; error: string } {
  const value = isRecord(error) ? error : {};
  const providerError = isRecord(value.error) ? value.error : {};
  const code = typeof providerError.code === "string"
    ? providerError.code
    : typeof value.code === "string"
      ? value.code
      : "CONNECTION_FAILED";
  const message = typeof providerError.message === "string"
    ? providerError.message
    : error instanceof Error
      ? error.message
      : "Unable to connect to OpenAI Realtime";
  return { code, error: redactCredential(message) };
}

function redactCredential(message: string): string {
  return message
    .replace(/(?:sk|sess)-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(Incorrect API key provided:\s*)[^.\s]+/gi, "$1[redacted]");
}

function eventLogDetails(event: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = { type: event.type };
  for (const key of ["event_id", "response_id", "item_id", "call_id"] as const) {
    if (typeof event[key] === "string") details[key] = event[key];
  }
  if (typeof event.content_index === "number") details.contentIndex = event.content_index;
  if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
    details.audioBytes = Buffer.byteLength(event.delta, "base64");
  }
  if (event.type === "error" && isRecord(event.error)) {
    if (typeof event.error.code === "string") details.code = event.error.code;
    if (typeof event.error.message === "string") details.error = redactCredential(event.error.message);
  }
  if (event.type === "response.done" && isRecord(event.response) && typeof event.response.status === "string") {
    details.status = event.response.status;
  }
  return details;
}

function sessionLogDetails(event: Record<string, unknown>): Record<string, unknown> {
  const session = isRecord(event.session) ? event.session : {};
  return {
    ...eventLogDetails(event),
    ...(typeof session.model === "string" ? { model: session.model } : {}),
    ...(Array.isArray(session.output_modalities) ? { outputModalities: session.output_modalities } : {}),
  };
}

function responseId(event: Record<string, unknown>): string | undefined {
  const response = isRecord(event.response) ? event.response : {};
  return typeof response.id === "string" ? response.id : typeof event.response_id === "string" ? event.response_id : undefined;
}

function responseStatus(event: Record<string, unknown>): string | undefined {
  const response = isRecord(event.response) ? event.response : {};
  return typeof response.status === "string" ? response.status : undefined;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
