import type { AgentConfiguration } from "../ports/agent-dependencies.js";
import type {
  AgentBehaviorConfiguration,
  AgentToolName,
  AgentToolPoliciesConfiguration,
  AgentTurnDetectionConfiguration,
  ConversationBehavior,
} from "./contracts.js";
import { PUBLIC_AGENT_TOOL_DEFINITIONS } from "./tool-definitions.js";

export const AGENT_CONFIGURATION_DEFAULTS_VERSION = 4;
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_CONVERSATION_VOICE = "marin";
export const DEFAULT_MAX_OUTPUT_TOKENS = 512;
export const DEFAULT_VAD_SILENCE_DURATION_MS = 800;
export const DEFAULT_IDLE_TIMEOUT_MS = 6_000;
export const DEFAULT_NOISE_REDUCTION = "near_field" as const;
export const DEFAULT_AGENT_BEHAVIOR: AgentBehaviorConfiguration = {
  allowPriceDisclosure: true,
  phoneReadback: "natural_grouped",
  greeting: { mode: "wait_for_caller" },
  responseStyle: { brevity: "brief", tone: "warm", pace: "balanced" },
  silence: {
    message: "I am still here. How may I help you?",
    maxPrompts: 1,
  },
  slotOffering: { maximumOptions: 1, strategy: "earliest_first" },
  dataCollectionOrder: ["full_name", "phone_number", "service"],
};

export function createDefaultAgentBehavior(locale: string): AgentBehaviorConfiguration {
  const behavior = structuredClone(DEFAULT_AGENT_BEHAVIOR);
  if (locale.toLowerCase().startsWith("es")) {
    behavior.silence.message = "¿Sigue en la línea? Puedo ayudarle cuando esté listo.";
  }
  return behavior;
}

export function createDefaultToolPolicies(enabledTools: AgentToolName[]): AgentToolPoliciesConfiguration {
  return {
    channels: {
      phone: { enabledTools: [...enabledTools], toolChoice: "auto", parallelToolCalls: false },
      voice_lab: { enabledTools: [...enabledTools], toolChoice: "auto", parallelToolCalls: false },
    },
    limits: { totalPerCall: 20, perTool: {} },
    externalRetryAttempts: 1,
    automaticTransfer: { onLimitReached: false, onRetryableFailure: false },
    confirmations: { requiredFor: [] },
  };
}

export interface DefaultAgentConfigurationInput {
  locale: string;
  businessName: string;
  model?: string;
  voice?: string;
  maxOutputTokens?: number;
  reasoningEffort?: ConversationBehavior["reasoningEffort"];
  turnDetection?: Partial<Extract<AgentTurnDetectionConfiguration, { type: "server_vad" }>>
    | AgentTurnDetectionConfiguration;
}

export function createDefaultAgentConfiguration(
  input: DefaultAgentConfigurationInput,
): AgentConfiguration {
  const enabledTools = PUBLIC_AGENT_TOOL_DEFINITIONS.map(({ name }) => name);
  return {
    schemaVersion: 4,
    identity: {
      instructions: [
        "Help callers complete supported receptionist tasks using the enabled tools.",
        "Ask only for information required by the selected task.",
      ].join(" "),
      locale: input.locale,
    },
    enabledTools,
    conversation: {
      model: input.model?.trim() || DEFAULT_REALTIME_MODEL,
      maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      reasoningEffort: input.reasoningEffort ?? "minimal",
      tracing: "disabled",
      truncation: { mode: "auto" },
    },
    audio: {
      voice: input.voice?.trim() || DEFAULT_CONVERSATION_VOICE,
      noiseReduction: DEFAULT_NOISE_REDUCTION,
      turnDetection: resolveTurnDetection(input.turnDetection),
    },
    behavior: createDefaultAgentBehavior(input.locale),
    toolPolicies: createDefaultToolPolicies(enabledTools),
  };
}

function resolveTurnDetection(
  input: DefaultAgentConfigurationInput["turnDetection"],
): AgentTurnDetectionConfiguration {
  if (input?.type === "semantic_vad" || input?.type === "manual") return structuredClone(input) as AgentTurnDetectionConfiguration;
  return {
    type: "server_vad",
    createResponse: input?.createResponse ?? true,
    interruptResponse: input?.interruptResponse ?? true,
    idleTimeoutMs: input?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(input?.threshold === undefined ? {} : { threshold: input.threshold }),
    ...(input?.prefixPaddingMs === undefined ? {} : { prefixPaddingMs: input.prefixPaddingMs }),
    silenceDurationMs: input?.silenceDurationMs ?? DEFAULT_VAD_SILENCE_DURATION_MS,
  };
}
