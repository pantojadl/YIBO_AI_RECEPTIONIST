import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadConfiguration,
} from "../../src/bootstrap/index.js";

describe("loadConfiguration", () => {
  it("defaults to the in-memory runtime and the approved realtime model", () => {
    expect(loadConfiguration({})).toEqual({
      runtime: "in-memory",
      openAiRealtimeModel: "gpt-realtime-2.1",
      conversationVoice: "marin",
      maxOutputTokens: 512,
      callMaxDurationMs: 15 * 60_000,
      callMaxTokens: 150_000,
      dashboardOrigin: "http://localhost:5173",
    });
  });

  it("loads an OpenAI runtime configuration without exposing a default secret", () => {
    expect(loadConfiguration({
      YIBO_RUNTIME: "openai-realtime",
      OPENAI_API_KEY: "test-key",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
    })).toEqual({
      runtime: "openai-realtime",
      openAiApiKey: "test-key",
      openAiRealtimeModel: "gpt-realtime-2.1",
      conversationVoice: "marin",
      maxOutputTokens: 512,
      callMaxDurationMs: 15 * 60_000,
      callMaxTokens: 150_000,
      dashboardOrigin: "http://localhost:5173",
    });
  });

  it("loads the organization admin key separately from the realtime key", () => {
    expect(loadConfiguration({ OPENAI_ADMIN_KEY: "admin-test-key" }))
      .toMatchObject({ openAiAdminKey: "admin-test-key" });
  });

  it("loads and validates voice output controls", () => {
    expect(loadConfiguration({
      YIBO_VOICE: "cedar",
      YIBO_MAX_OUTPUT_TOKENS: "768",
    })).toMatchObject({ conversationVoice: "cedar", maxOutputTokens: 768 });

    expect(() => loadConfiguration({ YIBO_MAX_OUTPUT_TOKENS: "4097" }))
      .toThrowError("YIBO_MAX_OUTPUT_TOKENS must be between 1 and 4096");
  });

  it("validates optional server VAD parameters without inventing defaults", () => {
    expect(loadConfiguration({
      YIBO_RUNTIME: "in-memory",
      YIBO_VAD_THRESHOLD: "0.5",
      YIBO_VAD_PREFIX_PADDING_MS: "300",
      YIBO_VAD_SILENCE_DURATION_MS: "500",
    })).toMatchObject({
      vadThreshold: 0.5,
      vadPrefixPaddingMs: 300,
      vadSilenceDurationMs: 500,
    });
    expect(() => loadConfiguration({
      YIBO_RUNTIME: "in-memory",
      YIBO_VAD_THRESHOLD: "1.1",
    })).toThrowError("YIBO_VAD_THRESHOLD must be between 0 and 1");
  });

  it("rejects a missing key for the OpenAI runtime", () => {
    expect(() => loadConfiguration({ YIBO_RUNTIME: "openai-realtime" }))
      .toThrowError(new ConfigurationError("OPENAI_API_KEY is required when YIBO_RUNTIME=openai-realtime"));
  });

  it("rejects unknown runtime names", () => {
    expect(() => loadConfiguration({ YIBO_RUNTIME: "other" }))
      .toThrowError(new ConfigurationError("YIBO_RUNTIME must be openai-realtime or in-memory"));
  });
});
