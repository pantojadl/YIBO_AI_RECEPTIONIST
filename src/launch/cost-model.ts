/**
 * Published list prices fetched 2026-10-20. These are quotes for planning,
 * not an invoice. Taxes, fees, and volume discounts are not included.
 * Audio tokens per minute are a planning assumption, not a measured YIBO call.
 * Historical OpenAI audio prices implied about 600 input tokens per audio
 * minute ($0.06/min at $100 per 1M) and about 1,200 output tokens per audio
 * minute ($0.24/min at $200 per 1M). Override both when a newer rate is known.
 */
export const RATE_CARD_AS_OF = "2026-10-20";

export const OPENAI_REALTIME_21_PRICES = {
  model: "gpt-realtime-2.1",
  audioInputUsdPerMillion: 32,
  audioCachedInputUsdPerMillion: 0.4,
  audioOutputUsdPerMillion: 64,
  textInputUsdPerMillion: 4,
  textOutputUsdPerMillion: 24,
  source: "https://developers.openai.com/api/docs/pricing",
} as const;

export const EXAMPLE_AUDIO_INPUT_TOKENS_PER_MINUTE = 600;
export const EXAMPLE_AUDIO_OUTPUT_TOKENS_PER_MINUTE = 1_200;

export const TELNYX_US_LIST = {
  didMonthlyUsd: 1,
  inboundPerMinuteUsd: 0.0032,
  outboundPerMinuteUsd: 0.005,
  sources: ["https://telnyx.com/pricing/numbers", "https://telnyx.com/pricing/elastic-sip"],
} as const;

export const TWILIO_US_LIST = {
  didMonthlyUsd: 1.15,
  inboundPerMinuteUsd: 0.0034,
  outboundPerMinuteUsd: 0.01,
  source: "https://www.twilio.com/en-us/sip-trunking/pricing/us",
} as const;

export const LIGHTSAIL_LINUX_IPV4_USD = {
  gb1: 7,
  gb2: 12,
  gb4: 24,
  source: "https://aws.amazon.com/lightsail/pricing/",
} as const;

export const PILOT_ENVELOPE_USD = 20;

export interface PilotCostInput {
  inboundMinutes: number;
  callerSpeechFraction?: number;
  assistantSpeechFraction?: number;
  audioInputTokensPerMinute?: number;
  audioOutputTokensPerMinute?: number;
  textInputTokens?: number;
  textOutputTokens?: number;
  didCount?: number;
  didMonthlyUsd: number;
  inboundPerMinuteUsd: number;
  hostMonthlyUsd: number;
  forwardedMinutes?: number;
  outboundPerMinuteUsd?: number;
  audioInputUsdPerMillion?: number;
  audioOutputUsdPerMillion?: number;
  textInputUsdPerMillion?: number;
  textOutputUsdPerMillion?: number;
}

export interface PilotCostEstimate {
  telephonyUsd: number;
  inferenceUsd: number;
  hostUsd: number;
  totalUsd: number;
  withinTwentyDollarEnvelope: boolean;
  audioInputTokens: number;
  audioOutputTokens: number;
}

export function estimatePilotCost(input: PilotCostInput): PilotCostEstimate {
  const caller = input.callerSpeechFraction ?? 0.45;
  const assistant = input.assistantSpeechFraction ?? 0.45;
  if (input.inboundMinutes < 0 || (input.forwardedMinutes ?? 0) < 0) {
    throw new Error("Minutes cannot be negative");
  }
  if (caller < 0 || assistant < 0 || caller + assistant > 1) {
    throw new Error("Speech fractions must be non-negative and sum to at most 1");
  }
  const inputTokensPerMinute = input.audioInputTokensPerMinute ?? EXAMPLE_AUDIO_INPUT_TOKENS_PER_MINUTE;
  const outputTokensPerMinute = input.audioOutputTokensPerMinute ?? EXAMPLE_AUDIO_OUTPUT_TOKENS_PER_MINUTE;
  const audioInputTokens = input.inboundMinutes * caller * inputTokensPerMinute;
  const audioOutputTokens = input.inboundMinutes * assistant * outputTokensPerMinute;
  const audioInputUsdPerMillion = input.audioInputUsdPerMillion ?? OPENAI_REALTIME_21_PRICES.audioInputUsdPerMillion;
  const audioOutputUsdPerMillion = input.audioOutputUsdPerMillion ?? OPENAI_REALTIME_21_PRICES.audioOutputUsdPerMillion;
  const textInputUsdPerMillion = input.textInputUsdPerMillion ?? OPENAI_REALTIME_21_PRICES.textInputUsdPerMillion;
  const textOutputUsdPerMillion = input.textOutputUsdPerMillion ?? OPENAI_REALTIME_21_PRICES.textOutputUsdPerMillion;
  const inferenceUsd = roundCents(
    (audioInputTokens / 1_000_000) * audioInputUsdPerMillion
    + (audioOutputTokens / 1_000_000) * audioOutputUsdPerMillion
    + ((input.textInputTokens ?? 0) / 1_000_000) * textInputUsdPerMillion
    + ((input.textOutputTokens ?? 0) / 1_000_000) * textOutputUsdPerMillion,
  );
  const dids = input.didCount ?? 1;
  const telephonyUsd = roundCents(
    dids * input.didMonthlyUsd
    + input.inboundMinutes * input.inboundPerMinuteUsd
    + (input.forwardedMinutes ?? 0) * (input.outboundPerMinuteUsd ?? 0),
  );
  const hostUsd = roundCents(input.hostMonthlyUsd);
  const totalUsd = roundCents(telephonyUsd + inferenceUsd + hostUsd);
  return {
    telephonyUsd,
    inferenceUsd,
    hostUsd,
    totalUsd,
    withinTwentyDollarEnvelope: totalUsd <= PILOT_ENVELOPE_USD,
    audioInputTokens,
    audioOutputTokens,
  };
}

export interface NamedScenario {
  name: string;
  estimate: PilotCostEstimate;
  note: string;
}

export function builtInScenarios(): NamedScenario[] {
  const zero = estimatePilotCost({
    inboundMinutes: 0,
    didCount: 0,
    didMonthlyUsd: 0,
    inboundPerMinuteUsd: 0,
    hostMonthlyUsd: 0,
    audioInputTokensPerMinute: 0,
    audioOutputTokensPerMinute: 0,
  });
  const scenarios: Array<{ name: string; minutes: number; host: number; note: string; did?: number }> = [
    { name: "demo-zero", minutes: 0, host: 0, did: 0, note: "Local simulation. No DID, no model calls, no host bill." },
    { name: "owner-hardware-50", minutes: 50, host: 0, note: "One Telnyx US local number on hardware the owner already runs." },
    { name: "owner-hardware-200", minutes: 200, host: 0, note: "Same number at 200 inbound minutes. Still an example, not a measurement." },
    { name: "owner-hardware-1000", minutes: 1000, host: 0, note: "Same number at 1,000 inbound minutes." },
    { name: "lightsail-2gb-200", minutes: 200, host: LIGHTSAIL_LINUX_IPV4_USD.gb2, note: "Adds a $12 Lightsail Linux IPv4 plan. 4 GB is $24 and is outside the $20 envelope before any calls." },
  ];
  return [
    { name: "demo-zero", estimate: zero, note: "Local simulation. No DID, no model calls, no host bill." },
    ...scenarios.filter((item) => item.name !== "demo-zero").map((item) => ({
      name: item.name,
      note: item.note,
      estimate: estimatePilotCost({
        inboundMinutes: item.minutes,
        didCount: item.did ?? 1,
        didMonthlyUsd: TELNYX_US_LIST.didMonthlyUsd,
        inboundPerMinuteUsd: TELNYX_US_LIST.inboundPerMinuteUsd,
        hostMonthlyUsd: item.host,
        outboundPerMinuteUsd: TELNYX_US_LIST.outboundPerMinuteUsd,
        forwardedMinutes: 0,
      }),
    })),
  ];
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
