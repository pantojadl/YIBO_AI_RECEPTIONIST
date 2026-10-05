import type {
  RealtimeAudioConfigInput,
  RealtimeAudioInputTurnDetection,
  RealtimeTruncation,
  SessionUpdateEvent,
} from "openai/resources/realtime/realtime";
import type { AgentToolDefinition } from "../../agents/index.js";
import { isDeveloperTestTool, RealtimeModelCapabilityRegistry } from "../../agents/index.js";
import type { OpenConversationInput } from "../ports/conversation-runtime-port.js";
import { REALTIME_AUDIO_TRANSPORT } from "../domain/realtime-transport-profile.js";

const capabilities = new RealtimeModelCapabilityRegistry();

export function buildRealtimeSessionUpdate(
  agent: OpenConversationInput["agent"],
  modality: "text" | "audio",
): SessionUpdateEvent {
  if (!agent.instructions.trim()) throw new Error("Realtime instructions are required");
  if (agent.channel && modality !== REALTIME_AUDIO_TRANSPORT.modality) {
    throw new Error(`Realtime ${agent.channel} sessions require audio modality`);
  }
  if (agent.channel !== "voice_lab" && agent.tools.some(({ name }) => isDeveloperTestTool(name))) {
    throw new Error("Developer Test Mode tools require an authorized Voice Lab session");
  }
  if (agent.tools.some(tool => tool.name === "end_call")
    && ((agent.channel !== "phone" && agent.channel !== "voice_lab") || agent.parallelToolCalls || agent.toolChoice === "none")) {
    throw new Error("Call completion requires a serial phone or Voice Lab session with tools enabled");
  }
  capabilities.validateRuntimeOptions({ ...agent,
    tools: agent.tools.filter((tool): tool is AgentToolDefinition => tool.name !== "end_call"),
  });

  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: agent.conversation.model,
      output_modalities: [modality],
      instructions: agent.instructions,
      ...(modality === "audio" ? {
        audio: {
          input: {
            format: REALTIME_AUDIO_TRANSPORT.providerFormat,
            // The API documents null as the explicit off value, but SDK 7.5 omits
            // null from this field's declaration.
            noise_reduction: agent.audio.noiseReduction === "disabled"
              ? null as unknown as RealtimeAudioConfigInput["noise_reduction"]
              : { type: agent.audio.noiseReduction },
            turn_detection: buildTurnDetectionPayload(agent.audio.turnDetection),
          },
          output: {
            format: REALTIME_AUDIO_TRANSPORT.providerFormat,
            voice: agent.audio.voice,
          },
        },
      } : {}),
      tools: agent.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
      tool_choice: agent.toolChoice,
      parallel_tool_calls: agent.parallelToolCalls,
      max_output_tokens: agent.conversation.maxOutputTokens,
      reasoning: { effort: agent.conversation.reasoningEffort },
      tracing: agent.conversation.tracing === "auto" ? "auto" : null,
      truncation: buildTruncationPayload(agent.conversation.truncation),
    },
  };
}

function buildTurnDetectionPayload(
  configuration: OpenConversationInput["agent"]["audio"]["turnDetection"],
): RealtimeAudioInputTurnDetection | null {
  if (configuration.type === "manual") return null;
  if (configuration.type === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: configuration.eagerness,
      create_response: configuration.createResponse,
      interrupt_response: configuration.interruptResponse,
    };
  }
  return {
    type: "server_vad",
    create_response: configuration.createResponse,
    interrupt_response: configuration.interruptResponse,
    ...(configuration.idleTimeoutMs === undefined ? {} : { idle_timeout_ms: configuration.idleTimeoutMs }),
    ...(configuration.threshold === undefined ? {} : { threshold: configuration.threshold }),
    ...(configuration.prefixPaddingMs === undefined ? {} : { prefix_padding_ms: configuration.prefixPaddingMs }),
    ...(configuration.silenceDurationMs === undefined ? {} : { silence_duration_ms: configuration.silenceDurationMs }),
  };
}

function buildTruncationPayload(
  configuration: OpenConversationInput["agent"]["conversation"]["truncation"],
): RealtimeTruncation {
  if (configuration.mode !== "retention_ratio") return configuration.mode;
  return {
    type: "retention_ratio",
    retention_ratio: configuration.retentionRatio,
    ...(configuration.postInstructionsTokens === undefined
      ? {}
      : { token_limits: { post_instructions: configuration.postInstructionsTokens } }),
  };
}
