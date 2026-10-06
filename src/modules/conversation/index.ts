export { ConversationService, SPEND_FORCED_SHUTDOWN_MS } from "./application/conversation-service.js";
export type {
  AudioSink,
  ConversationCompletion,
  ConversationError,
  ConversationServiceContract,
  ConversationServiceDependencies,
  ConversationSession,
  ConversationTransport,
  StartConversationCommand,
} from "./application/contracts.js";
export type {
  AudioFrame,
  AssistantPlaybackPosition,
  ConversationRuntimeEvent,
  ConversationRuntimePort,
  ConversationRuntimeSession,
  OpenConversationInput,
  ToolResultEnvelope,
} from "./ports/conversation-runtime-port.js";
export type {
  ConversationUsageIncrement,
  ConversationUsageReader,
  ConversationUsageRecorder,
  ConversationUsageSummary,
} from "./ports/conversation-usage.js";
export {
  ScriptedConversationRuntime,
  ScriptedConversationRuntimeSession,
} from "./infrastructure/scripted-conversation-runtime.js";
export { OpenAIRealtimeAdapter } from "./infrastructure/openai-realtime-adapter.js";
export { buildRealtimeSessionUpdate } from "./infrastructure/realtime-session-payload.js";
export { REALTIME_AUDIO_TRANSPORT } from "./domain/realtime-transport-profile.js";
export type {
  OpenAIRealtimeAdapterOptions,
  RealtimeConnection,
  RealtimeConnectionFactory,
  RealtimeErrorLogger,
  ServerTurnDetectionOptions,
} from "./infrastructure/openai-realtime-adapter.js";
