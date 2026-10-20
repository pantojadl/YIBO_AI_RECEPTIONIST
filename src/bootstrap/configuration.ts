export type RuntimeKind = "openai-realtime" | "in-memory";

export interface ApplicationConfiguration {
  runtime: RuntimeKind;
  openAiRealtimeModel: string;
  conversationVoice: string;
  maxOutputTokens: number;
  dashboardOrigin: string;
  openAiApiKey?: string;
  openAiAdminKey?: string;
  vadThreshold?: number;
  vadPrefixPaddingMs?: number;
  vadSilenceDurationMs?: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfiguration(environment: NodeJS.ProcessEnv = process.env): ApplicationConfiguration {
  assertLaunchSafety(environment);
  const runtime = environment.YIBO_RUNTIME?.trim() || "in-memory";
  if (runtime !== "openai-realtime" && runtime !== "in-memory") {
    throw new ConfigurationError("YIBO_RUNTIME must be openai-realtime or in-memory");
  }

  const openAiRealtimeModel = environment.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
  const conversationVoice = environment.YIBO_VOICE?.trim() || DEFAULT_CONVERSATION_VOICE;
  const maxOutputTokens = optionalIntegerInRange(
    environment.YIBO_MAX_OUTPUT_TOKENS,
    "YIBO_MAX_OUTPUT_TOKENS",
    1,
    4096,
  ) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const dashboardOrigin = validOrigin(environment.YIBO_DASHBOARD_ORIGIN?.trim() || "http://localhost:5173");
  const openAiApiKey = environment.OPENAI_API_KEY?.trim();
  const openAiAdminKey = environment.OPENAI_ADMIN_KEY?.trim();
  const vadThreshold = optionalNumber(environment.YIBO_VAD_THRESHOLD, "YIBO_VAD_THRESHOLD", 0, 1);
  const vadPrefixPaddingMs = optionalInteger(environment.YIBO_VAD_PREFIX_PADDING_MS, "YIBO_VAD_PREFIX_PADDING_MS");
  const vadSilenceDurationMs = optionalInteger(environment.YIBO_VAD_SILENCE_DURATION_MS, "YIBO_VAD_SILENCE_DURATION_MS");
  if (runtime === "openai-realtime" && !openAiApiKey) {
    throw new ConfigurationError("OPENAI_API_KEY is required when YIBO_RUNTIME=openai-realtime");
  }

  return {
    runtime,
    openAiRealtimeModel,
    conversationVoice,
    maxOutputTokens,
    dashboardOrigin,
    ...(openAiApiKey ? { openAiApiKey } : {}),
    ...(openAiAdminKey ? { openAiAdminKey } : {}),
    ...(vadThreshold === undefined ? {} : { vadThreshold }),
    ...(vadPrefixPaddingMs === undefined ? {} : { vadPrefixPaddingMs }),
    ...(vadSilenceDurationMs === undefined ? {} : { vadSilenceDurationMs }),
  };
}

const disabledValues = new Set(["", "0", "false", "off", "disabled", "no"]);

function assertLaunchSafety(environment: NodeJS.ProcessEnv): void {
  const recording = environment.YIBO_CALL_RECORDING?.trim().toLowerCase() ?? "";
  if (!disabledValues.has(recording)) {
    throw new ConfigurationError("YIBO_CALL_RECORDING must stay off. This build does not record calls.");
  }
  const outbound = environment.YIBO_OUTBOUND_DIALING?.trim().toLowerCase() ?? "";
  if (!disabledValues.has(outbound)) {
    throw new ConfigurationError("YIBO_OUTBOUND_DIALING is not supported. YIBO is inbound-only.");
  }
}

function validOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new ConfigurationError("YIBO_DASHBOARD_ORIGIN must be an HTTP(S) origin without path");
  }
}

function optionalNumber(raw: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalInteger(raw: string | undefined, name: string): number | undefined {
  const value = optionalNumber(raw, name, 0, Number.MAX_SAFE_INTEGER);
  if (value !== undefined && !Number.isInteger(value)) throw new ConfigurationError(`${name} must be a non-negative integer`);
  return value;
}

function optionalIntegerInRange(
  raw: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalNumber(raw, name, minimum, maximum);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new ConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
import {
  DEFAULT_CONVERSATION_VOICE,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REALTIME_MODEL,
} from "../modules/agents/index.js";
