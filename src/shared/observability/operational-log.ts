import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface OperationalContext { tenantId: string; locationId: string; callId: string }
const context = new AsyncLocalStorage<OperationalContext>();
export const withOperationalContext = <T>(value: OperationalContext, work: () => T): T => context.run(value, work);
const correlation = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const numericFields = new Set(["durationMs", "sampleCount", "p50Ms", "p95Ms", "slotCount", "bytes", "audioBytes", "queueDepth", "firstAudioToFirstRtpMs", "assistantTurnNumber", "outboundQueueDepth", "underruns", "overruns", "packetCount", "minElapsedMs", "maxElapsedMs", "averageElapsedMs", "p95ElapsedMs", "p99ElapsedMs", "packetsOver25Ms", "packetsOver30Ms", "packetsOver40Ms", "maxBufferedAudioMs", "averageBufferedAudioMs", "finalDrainMs", "echoCorrelation"]);
const codes = new Set(["CONFIRMATION_REQUIRED", "INVALID_CONFIRMATION_TOKEN", "CONFIRMATION_MISMATCH", "CONFIRMATION_EXPIRED", "CONFIRMATION_PENDING_NEW_TURN", "CALENDAR_SYNC_FAILED", "EXTERNAL_CALENDAR_UNAVAILABLE", "ACTION_OUTCOME_UNKNOWN", "TOOL_TIMEOUT", "TOOL_EXECUTION_FAILED", "SLOT_NO_LONGER_AVAILABLE", "TRANSFER_FAILED", "TRANSFER_NOT_CONFIGURED", "TOOL_LIMIT_REACHED", "RUNTIME_ERROR", "AUDIO_TRANSPORT_ERROR", "CONNECTION_FAILED"]);
const labels = new Set(["started", "completed", "failed", "cancelled", "closed", "unknown", "speech_started", "speech_stopped", "silence_timeout", "interrupted", "create_appointment", "cancel_appointment", "reschedule_appointment", "transfer_to_human", "get_service_information", "list_customer_appointments", "check_availability", "update_customer", "speech_to_response", "speech_to_first_audio", "speech_to_response_done", "first_audio_to_rtp", "tool_round_trip", "session_startup", "session_duration", "turn_duration", "cleanup"]);
const secretText = /bearer\s+\S+|refresh_token|access_token|client_secret|ya29\./i;

/** Fixed fields only: no transcripts, tool arguments/results, dates, calendar IDs or errors. */
export function operationalRecord(event: string, metadata: Record<string, unknown> = {}, trusted = context.getStore()): Record<string, unknown> {
  const record: Record<string, unknown> = { event: /^[a-z][a-z0-9_.]{0,99}$/.test(event) ? event : "diagnostic", timestamp: new Date().toISOString() };
  const tenant = trusted?.tenantId ?? (typeof metadata.tenantId === "string" ? metadata.tenantId : undefined);
  const location = trusted?.locationId ?? (typeof metadata.locationId === "string" ? metadata.locationId : undefined);
  const call = trusted?.callId ?? (typeof metadata.callId === "string" ? metadata.callId : undefined);
  if (tenant) record.tenant = correlation(tenant);
  if (location) record.location = correlation(`${tenant ?? ""}:${location}`);
  if (call) record.call = correlation(call);
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && secretText.test(value)) continue;
    if (numericFields.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = Math.round(value * 100) / 100;
    if (["phase", "metric", "tool"].includes(key) && typeof value === "string") record[key] = labels.has(value) ? value : "unknown";
    if (key === "code" && typeof value === "string") record.code = codes.has(value) ? value : "OTHER";
    if (["available", "ok"].includes(key) && typeof value === "boolean") record[key] = value;
  }
  return record;
}
const frameEvents = new Set(["telephony.media.rtp_received", "telephony.media.rtp_sent", "telephony.media.rtp_queued", "telephony.media.realtime_audio_received", "telephony.media.realtime_audio_sent"]);
export function operationalLog(event: string, metadata: Record<string, unknown> = {}, trusted?: OperationalContext): void {
  if (frameEvents.has(event)) return; // Keep summaries/errors, not a log per media frame.
  try { console.log(JSON.stringify(operationalRecord(event, metadata, trusted))); } catch { /* Telemetry must not fail an operation. */ }
}
