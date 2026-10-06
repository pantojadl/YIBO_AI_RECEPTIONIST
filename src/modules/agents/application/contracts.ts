import type { Result } from "../../../shared/domain/result.js";
import type {
  CallId,
  CustomerId,
  LocationId,
  TenantId,
  ToolCallId,
} from "../../../shared/types/identifiers.js";

export type AgentToolName =
  | "get_service_information"
  | "list_customer_appointments"
  | "check_availability"
  | "create_appointment"
  | "update_customer"
  | "cancel_appointment"
  | "reschedule_appointment"
  | "transfer_to_human"
  | "enable_developer_test_mode"
  | "delete_test_appointments";

export interface AgentToolDefinition {
  name: AgentToolName;
  description: string;
  inputSchema: object;
  presentation?: {
    title: string;
    help: string;
    route: string;
    icon: string;
    kind: "consult" | "mutate" | "external";
  };
}

export interface AgentToolCall {
  toolCallId: ToolCallId;
  name: AgentToolName;
  arguments: unknown;
}

export type AgentToolResult =
  | { toolCallId: ToolCallId; ok: true; data: unknown }
  | {
      toolCallId: ToolCallId;
      ok: false;
      error: { code: string; messageForAgent: string; retryable: boolean; confirmationToken?: string };
    };

export interface TrustedCallContext {
  tenantId: TenantId;
  locationId: LocationId;
  callId: CallId;
  customerId?: CustomerId;
  /** Server-trusted and available only from the local development harness. */
  developerTestModeAuthorized?: true;
}

export interface ToolExecutionContext extends TrustedCallContext {
  /** Monotonic sequence assigned by Conversation from caller turns, never by the model. */
  turnSequence: number;
}

export interface ToolExecutor {
  execute(context: ToolExecutionContext, call: AgentToolCall): Promise<AgentToolResult>;
}

export interface PrepareAgentDefinitionCommand extends TrustedCallContext {}

export interface AgentDefinition {
  instructions: string;
  locale: string;
  voice?: string;
  conversation: AgentConversationConfiguration;
  audio: AgentAudioConfiguration;
  behavior: AgentBehaviorConfiguration;
  toolChoice: "auto" | "required" | "none";
  parallelToolCalls: boolean;
  channel: AgentChannel;
  tools: AgentToolDefinition[];
  toolExecutor: ToolExecutor;
  trustedContext: TrustedCallContext;
}

export interface AgentConversationConfiguration {
  model: string;
  maxOutputTokens: number;
  reasoningEffort: "minimal" | "low" | "medium" | "high";
  tracing: "disabled" | "auto";
  truncation:
    | { mode: "auto" | "disabled" }
    | { mode: "retention_ratio"; retentionRatio: number; postInstructionsTokens?: number };
}

export interface AgentBehaviorConfiguration {
  /** Missing in older documents means true. Applies only to caller-facing AI output. */
  allowPriceDisclosure?: boolean;
  phoneReadback?: "natural_grouped" | "digit_by_digit";
  greeting:
    | { mode: "wait_for_caller" }
    | { mode: "automatic"; message: string };
  responseStyle: {
    brevity: "brief" | "balanced" | "detailed";
    tone: "warm" | "professional" | "direct";
    pace: "slow" | "balanced" | "fast";
  };
  silence: {
    message: string;
    maxPrompts: number;
  };
  slotOffering: {
    maximumOptions: number;
    strategy: "earliest_first" | "spread_across_day" | "match_requested_time";
  };
  dataCollectionOrder: AgentDataCollectionField[];
}

export type AgentDataCollectionField = "full_name" | "phone_number" | "service";

export type AgentChannel = "phone" | "voice_lab";

export interface AgentToolPoliciesConfiguration {
  channels: Record<AgentChannel, {
    enabledTools: AgentToolName[];
    toolChoice: "auto" | "required" | "none";
    parallelToolCalls: boolean;
  }>;
  limits: {
    totalPerCall: number;
    perTool: Partial<Record<AgentToolName, number>>;
  };
  externalRetryAttempts: number;
  automaticTransfer: {
    onLimitReached: boolean;
    onRetryableFailure: boolean;
  };
  confirmations: {
    requiredFor: AgentToolName[];
  };
}

export type ConversationBehavior = AgentConversationConfiguration;

export interface AgentAudioConfiguration {
  voice: string;
  noiseReduction: "disabled" | "near_field" | "far_field";
  turnDetection: AgentTurnDetectionConfiguration;
}

export type AgentTurnDetectionConfiguration =
  | {
      type: "server_vad";
      threshold?: number;
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
      idleTimeoutMs?: number | null;
      createResponse: boolean;
      interruptResponse: boolean;
    }
  | {
      type: "semantic_vad";
      eagerness: "auto" | "low" | "medium" | "high";
      createResponse: boolean;
      interruptResponse: boolean;
    }
  | { type: "manual" };

export type AgentDefinitionError = {
  code: "CONFIGURATION_NOT_FOUND" | "BUSINESS_CONTEXT_NOT_FOUND" | "CHANNEL_CONFIGURATION_INCOMPATIBLE";
};

export interface AgentDefinitionFactory {
  prepare(
    command: PrepareAgentDefinitionCommand,
  ): Promise<Result<AgentDefinition, AgentDefinitionError>>;
}
