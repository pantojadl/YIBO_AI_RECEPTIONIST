import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_DEFINITIONS,
  DEFAULT_AGENT_BEHAVIOR,
} from "../../src/modules/agents/index.js";
import { buildRealtimeSessionUpdate } from "../../src/modules/conversation/index.js";

const supportedModels = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const;

describe("buildRealtimeSessionUpdate", () => {
  it.each(["phone", "voice_lab"] as const)("accepts call completion in a serial %s session", channel => {
    const value = agent("gpt-realtime-2.1");
    value.channel = channel;
    value.parallelToolCalls = false;
    value.tools.push({ name: "end_call", description: "End after farewell", inputSchema: { type: "object", additionalProperties: false, properties: {} } });
    const payload = buildRealtimeSessionUpdate(value, "audio");
    if (payload.session.type !== "realtime") throw new Error("Expected an audio Realtime session");
    expect(payload.session.tools).toContainEqual(expect.objectContaining({ name: "end_call" }));
    expect(payload.session.parallel_tool_calls).toBe(false);
  });

  it.each(["no-channel", "parallel", "disabled"])("keeps call completion blocked for %s", mode => {
    const value = agent("gpt-realtime-2.1");
    value.channel = "voice_lab";
    value.parallelToolCalls = mode === "parallel";
    if (mode === "no-channel") delete value.channel;
    if (mode === "disabled") value.toolChoice = "none";
    value.tools = [{ name: "end_call", description: "End after farewell", inputSchema: { type: "object" } }];
    expect(() => buildRealtimeSessionUpdate(value, "audio")).toThrow("Call completion requires");
  });
  it.each(supportedModels)("matches the validated audio payload contract for %s", (model) => {
    expect(buildRealtimeSessionUpdate(agent(model), "audio")).toEqual(expectedPayload(model));
  });

  it("rejects an unsupported model before generating provider data", () => {
    expect(() => buildRealtimeSessionUpdate(agent("unregistered-realtime-model"), "audio"))
      .toThrow("conversation.model is not supported: unregistered-realtime-model");
  });

  it("rejects a text payload for a trusted product channel", () => {
    expect(() => buildRealtimeSessionUpdate(agent("gpt-realtime-2.1"), "text"))
      .toThrow("Realtime phone sessions require audio modality");
  });

  it("rejects Developer Test Mode tools outside an authorized Voice Lab definition", () => {
    const unsafe = agent("gpt-realtime-2.1");
    unsafe.tools = [AGENT_TOOL_DEFINITIONS.find(({ name }) => name === "enable_developer_test_mode")!];

    expect(() => buildRealtimeSessionUpdate(unsafe, "audio"))
      .toThrow("Developer Test Mode tools require an authorized Voice Lab session");
  });
});

function agent(model: string): Parameters<typeof buildRealtimeSessionUpdate>[0] {
  return {
    instructions: "Help the caller safely.",
    locale: "es-MX",
    voice: "marin",
    channel: "phone" as const,
    conversation: {
      model,
      maxOutputTokens: 640,
      reasoningEffort: "low" as const,
      tracing: "disabled" as const,
      truncation: { mode: "auto" as const },
    },
    audio: {
      voice: "marin",
      noiseReduction: "near_field" as const,
      turnDetection: {
        type: "server_vad" as const,
        threshold: 0.55,
        prefixPaddingMs: 300,
        silenceDurationMs: 700,
        idleTimeoutMs: 6_000,
        createResponse: true,
        interruptResponse: true,
      },
    },
    behavior: structuredClone(DEFAULT_AGENT_BEHAVIOR),
    toolChoice: "auto" as const,
    parallelToolCalls: true,
    tools: [{
      name: "check_availability" as const,
      description: "Find available times",
      inputSchema: { type: "object", additionalProperties: false },
      presentation: {
        title: "Availability",
        help: "Read-only availability lookup",
        route: "/availability",
        icon: "calendar",
        kind: "consult" as const,
      },
    }],
  };
}

function expectedPayload(model: string) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      output_modalities: ["audio"],
      instructions: "Help the caller safely.",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.55,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
            idle_timeout_ms: 6_000,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
      },
      tools: [{
        type: "function",
        name: "check_availability",
        description: "Find available times",
        parameters: { type: "object", additionalProperties: false },
      }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_output_tokens: 640,
      reasoning: { effort: "low" },
      tracing: null,
      truncation: "auto",
    },
  };
}
