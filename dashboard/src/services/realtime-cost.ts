import type { RealtimeModelPricing } from "./api.js";

export interface RealtimeSessionUsage {
  inputTokens: number;
  outputTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  cachedInputTokens: number;
  cachedInputTextTokens: number;
  cachedInputAudioTokens: number;
  inputAudioMs: number;
  outputAudioMs: number;
  toolCalls: number;
}

export const emptyRealtimeSessionUsage = (): RealtimeSessionUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  inputTextTokens: 0,
  outputTextTokens: 0,
  inputAudioTokens: 0,
  outputAudioTokens: 0,
  cachedInputTokens: 0,
  cachedInputTextTokens: 0,
  cachedInputAudioTokens: 0,
  inputAudioMs: 0,
  outputAudioMs: 0,
  toolCalls: 0,
});

export interface RealtimeCostState {
  usage: RealtimeSessionUsage;
  startedAt?: number;
  endedAt?: number;
}

export const emptyRealtimeCostState = (): RealtimeCostState => ({ usage: emptyRealtimeSessionUsage() });

/** Follow the shared Voice Lab lifecycle; each fresh test owns its own estimate. */
export function observeRealtimeCostEvent(state: RealtimeCostState, event: Record<string, unknown>, now: number): RealtimeCostState {
  const name = event.event ?? event.type;
  if (name === "test.started") return emptyRealtimeCostState();
  if (name === "conversation.opened" && state.startedAt === undefined) return { ...state, startedAt: now };
  if (name === "usage" && state.startedAt !== undefined && state.endedAt === undefined) {
    return { ...state, usage: addRealtimeUsage(state.usage, event) };
  }
  if (["test.completed", "conversation.closed"].includes(String(name)) && state.startedAt !== undefined && state.endedAt === undefined) {
    return { ...state, endedAt: now };
  }
  return state;
}

export function addRealtimeUsage(
  current: RealtimeSessionUsage,
  increment: Record<string, unknown>,
): RealtimeSessionUsage {
  const next = { ...current };
  for (const key of Object.keys(next) as Array<keyof RealtimeSessionUsage>) {
    const value = increment[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) next[key] += value;
  }
  return next;
}

export function estimateRealtimeCost(
  usage: RealtimeSessionUsage,
  pricing?: RealtimeModelPricing,
): number | null {
  if (!pricing) return null;
  const inputAudio = usage.inputAudioTokens || Math.round(usage.inputAudioMs / 100);
  const outputAudio = usage.outputAudioTokens || Math.round(usage.outputAudioMs / 50);
  const inputText = usage.inputTextTokens || Math.max(0, usage.inputTokens - inputAudio);
  const outputText = usage.outputTextTokens || Math.max(0, usage.outputTokens - outputAudio);
  const cachedAudio = Math.min(inputAudio, usage.cachedInputAudioTokens);
  const cachedText = Math.min(inputText, usage.cachedInputTextTokens);
  const unclassifiedCached = Math.max(0, usage.cachedInputTokens - cachedAudio - cachedText);
  const uncachedText = Math.max(0, inputText - cachedText - unclassifiedCached);
  const uncachedAudio = Math.max(0, inputAudio - cachedAudio);
  const total =
    uncachedText * pricing.text.input
    + (cachedText + unclassifiedCached) * pricing.text.cachedInput
    + uncachedAudio * pricing.audio.input
    + cachedAudio * pricing.audio.cachedInput
    + outputText * pricing.text.output
    + outputAudio * pricing.audio.output;
  return total / pricing.unitTokens;
}
