import type {
  AgentDefinition,
} from "../../agents/index.js";
import type {
  AudioFrame,
  AssistantPlaybackPosition,
  ConversationRuntimeEvent,
  ConversationRuntimePort,
  ConversationRuntimeSession,
} from "../ports/conversation-runtime-port.js";
import type { ConversationUsageRecorder } from "../ports/conversation-usage.js";

export interface AudioSink {
  /** Finish a completed final turn, padding a transport packet if necessary. */
  finishAudio?(assistantTurnId: string): void;
  onFirstAudioSent?(listener: (assistantTurnId: string) => void): () => void;
  write(frame: AudioFrame, assistantTurnId: string): Promise<void>;
  /** Callback after queued audio actually drains; never inferred from model response.done. */
  onPlaybackIdle?(listener: () => void): () => void;
  getBargeInDiagnostics?(): { outboundRtpPlaying: boolean; outboundQueueDepth: number; assistantPlaybackMs?: number; echoCorrelation?: number; echoSuspected?: boolean };
  interrupt?(): Promise<AssistantPlaybackPosition | undefined>;
}

export interface ConversationTransport {
  inboundAudio: AsyncIterable<AudioFrame>;
  outboundAudio: AudioSink;
  close(): Promise<void>;
  /**
   * Optional, non-persistent runtime diagnostics for a call transport.  This
   * lets the development voice harness display VAD, usage, and provider errors
   * without coupling the Calls module to that harness.
   */
  observeEvent?(event: ConversationRuntimeEvent): void;
}

export interface StartConversationCommand {
  conversationId: string;
  agent: AgentDefinition;
  transport: ConversationTransport;
  observeEvent?(event: ConversationRuntimeEvent): void;
}

export interface CallSpendLimit {
  maxDurationMs: number;
  maxTokens: number;
}

export interface ConversationServiceDependencies {
  runtime: ConversationRuntimePort;
  usageRecorder?: ConversationUsageRecorder;
  /** Hard per-call OpenAI cap. Omitted values use the built-in defaults. */
  spendLimit?: CallSpendLimit;
}

export type ConversationCompletion =
  | { status: "closed"; reason?: string }
  | { status: "failed"; error: ConversationError };

export type ConversationError =
  | { code: "RUNTIME_ERROR"; message: string; retryable: boolean }
  | { code: "AUDIO_TRANSPORT_ERROR"; message: string }
  | { code: "TOOL_EXECUTION_ERROR"; message: string };

export interface ConversationSession {
  completed: Promise<ConversationCompletion>;
  sendText(text: string): Promise<void>;
  interrupt(position?: AssistantPlaybackPosition): Promise<void>;
  close(): Promise<void>;
}

export interface ConversationServiceContract {
  start(command: StartConversationCommand): Promise<ConversationSession>;
}

export interface ConversationSessionControllerDependencies {
  runtimeSession: ConversationRuntimeSession;
  command: StartConversationCommand;
  usageRecorder?: ConversationUsageRecorder;
  spendLimit?: CallSpendLimit;
}
