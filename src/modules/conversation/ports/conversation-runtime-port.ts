import type { AgentDefinition, AgentToolName, AgentToolDefinition } from "../../agents/index.js";

export interface AudioFrame {
  data: Uint8Array;
  codec: string;
  sampleRate: number;
  channels: number;
  timestampMs?: number;
}

export interface AssistantPlaybackPosition {
  assistantTurnId: string;
  audioEndMs: number;
}

export type ConversationToolName = AgentToolName | "end_call";

export interface OpenConversationInput {
  conversationId: string;
  agent: Pick<AgentDefinition, "instructions" | "locale" | "voice" | "conversation" | "audio" | "behavior" | "toolChoice" | "parallelToolCalls">
    & { channel?: AgentDefinition["channel"]; tools: Array<Omit<AgentToolDefinition, "name"> & { name: ConversationToolName }> };
}

export type ToolResultEnvelope =
  | { toolCallId: string; ok: true; data: unknown }
  | {
      toolCallId: string;
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        confirmationToken?: string;
      };
    };

export type ConversationRuntimeEvent =
  | { type: "audio.delta"; assistantTurnId: string; frame: AudioFrame }
  | { type: "user.speech_started"; occurredAt?: string }
  | { type: "user.speech_stopped"; occurredAt?: string }
  | {
      type: "tool.call";
      toolCallId: string;
      name: ConversationToolName;
      arguments: unknown;
    }
  | { type: "assistant.transcript"; text: string; final: boolean }
  | { type: "assistant.response_created"; responseId?: string }
  | { type: "assistant.response_done"; status?: string }
  | { type: "assistant.audio_completed"; assistantTurnId?: string }
  | { type: "silence.timeout" }
  | { type: "tool.execution"; phase: "started" | "completed" | "failed"; outcomeCode?: string; toolCallId: string; name: ConversationToolName }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      inputTextTokens?: number;
      outputTextTokens?: number;
      inputAudioTokens?: number;
      outputAudioTokens?: number;
      cachedInputTokens?: number;
      cachedInputTextTokens?: number;
      cachedInputAudioTokens?: number;
      inputAudioMs?: number;
      outputAudioMs?: number;
      toolCalls?: number;
    }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "closed"; reason?: string };

export interface ConversationRuntimePort {
  openSession(input: OpenConversationInput): Promise<ConversationRuntimeSession>;
}

export interface ConversationRuntimeSession {
  sendText(text: string): Promise<void>;
  sendAudio(frame: AudioFrame): Promise<void>;
  /** Ask the model for one spoken turn, without adding a caller message. */
  requestResponse?(instructions: string): Promise<void>;
  sendToolResult(result: ToolResultEnvelope, options?: { requestResponse: boolean }): Promise<void>;
  interrupt(position?: AssistantPlaybackPosition): Promise<void>;
  close(): Promise<void>;
  events(): AsyncIterable<ConversationRuntimeEvent>;
}
