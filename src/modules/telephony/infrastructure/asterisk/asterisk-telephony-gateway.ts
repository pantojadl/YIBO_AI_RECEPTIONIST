import { failure, success } from "../../../../shared/domain/result.js";
import type { CallId } from "../../../../shared/types/identifiers.js";
import type {
  TelephonyError,
  TelephonyEvent,
  TelephonyGateway,
  TransferDestination,
} from "../../application/contracts.js";
import { canonicalizeCalledNumber } from "./called-number.js";
import { AsteriskCallRegistry } from "./asterisk-call-registry.js";
import type { AsteriskClient, AsteriskEvent, AsteriskFailure } from "./asterisk-client.js";

export interface AsteriskTelephonyOptions {
  /** External phone transfers place a billable outbound leg. Off unless explicitly enabled. */
  allowExternalTransfer?: boolean;
  /** When US, 10-digit and 11-digit NANP called numbers become +1 E.164 before tenant lookup. */
  calledNumberRegion?: string;
}

export class AsteriskTelephonyGateway implements TelephonyGateway {
  private readonly handlers: Array<(event: TelephonyEvent) => Promise<void>> = [];
  private readonly calls: AsteriskCallRegistry;
  private readonly activeCalls = new Set<string>();

  constructor(
    client: AsteriskClient,
    createCallId: () => CallId,
    private readonly media?: { prepare(callId: string, channelId: string): Promise<void>; cleanup(callId: string): Promise<void> },
    private readonly options: AsteriskTelephonyOptions = {},
  ) {
    this.client = client;
    this.calls = new AsteriskCallRegistry(createCallId);
    client.onEvent((event) => this.handleAsteriskEvent(event));
  }

  private readonly client: AsteriskClient;

  onEvent(handler: (event: TelephonyEvent) => Promise<void>): void {
    this.handlers.push(handler);
  }

  async answer(callId: CallId) {
    return this.withChannel(callId, async channelId => {
      // CallOrchestrator resolves trusted DID/location before answering.
      await this.media?.prepare(callId, channelId);
      await this.client.answer(channelId);
    });
  }

  async hangup(callId: CallId) {
    const result = await this.withChannel(callId, (channelId) => this.client.hangup(channelId));
    await this.media?.cleanup(callId);
    return result;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.activeCalls].map(callId => this.hangup(callId)));
    this.activeCalls.clear();
    (this.client as AsteriskClient & {close?(): void}).close?.();
  }

  async transfer(callId: CallId, destination: TransferDestination) {
    if (destination.type === "PHONE_NUMBER" && !this.options.allowExternalTransfer) {
      return failure<TelephonyError>({
        code: "INVALID_DESTINATION",
        message: "External phone transfers are disabled. This pilot allows internal extensions only.",
      });
    }
    const normalized = normalizeDestination(destination);
    if (!normalized) {
      return failure<TelephonyError>({
        code: "INVALID_DESTINATION",
        message: destination.type === "PHONE_NUMBER"
          ? "Phone number must contain between 7 and 15 digits"
          : "Extension must contain between 1 and 8 digits",
      });
    }
    return this.withChannel(callId, (channelId) => this.client.transfer(channelId, normalized));
  }

  private async withChannel(callId: CallId, operation: (channelId: string) => Promise<void>) {
    const channelId = this.calls.channelIdForCall(callId);
    if (!channelId) return failure<TelephonyError>({ code: "CALL_NOT_FOUND" });
    try {
      await operation(channelId);
      return success(undefined);
    } catch (error) {
      return failure<TelephonyError>(mapAsteriskFailure(error));
    }
  }

  private async handleAsteriskEvent(event: AsteriskEvent): Promise<void> {
    if (event.type === "CHANNEL_ENTERED_APPLICATION") {
      if (this.calls.callIdForChannel(event.channelId)) return;
      const callId = this.calls.register(event.channelId);
      this.activeCalls.add(callId);
      return this.emit({
        type: "INCOMING_CALL",
        callId,
        from: event.callerNumber,
        to: canonicalizeCalledNumber(event.dialedNumber, this.options.calledNumberRegion),
        occurredAt: normalizedTimestamp(event.occurredAt),
      });
    }
    const callId = event.type === "CHANNEL_DESTROYED"
      ? this.calls.unregisterChannel(event.channelId)
      : this.calls.callIdForChannel(event.channelId);
    if (!callId) return;
    if (event.type === "CHANNEL_DESTROYED") {
      this.activeCalls.delete(callId);
      await Promise.all([
        Promise.resolve().then(() => this.media?.cleanup(callId)).catch(() => undefined),
        this.emit({ type: "CALL_HUNG_UP", callId, occurredAt: normalizedTimestamp(event.occurredAt) }),
      ]);
      return;
    }
    if (/^[0-9A-D*#]$/.test(event.digit)) {
      return this.emit({
        type: "DTMF_RECEIVED",
        callId,
        digit: event.digit,
        occurredAt: normalizedTimestamp(event.occurredAt),
      });
    }
  }

  private async emit(event: TelephonyEvent): Promise<void> {
    await Promise.all(this.handlers.map((handler) => handler(event)));
  }
}

const normalizeDestination = (destination: TransferDestination): { kind: "phone" | "extension"; value: string } | null => {
  const digits = destination.value.replace(/\D/g, "");
  if (destination.type === "PHONE_NUMBER") {
    if (digits.length < 7 || digits.length > 15) return null;
    return { kind: "phone", value: destination.value.trim().startsWith("+") ? `+${digits}` : digits };
  }
  if (!/^\d{1,8}$/.test(destination.value.trim())) return null;
  return { kind: "extension", value: destination.value.trim() };
};

const normalizedTimestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
};

const mapAsteriskFailure = (error: unknown): TelephonyError => {
  const failure = typeof error === "object" && error !== null ? error as AsteriskFailure : {};
  if (failure.code === "CHANNEL_NOT_FOUND") return { code: "CALL_NOT_FOUND" };
  if (failure.code === "CONNECTION_UNAVAILABLE") {
    return { code: "PROVIDER_UNAVAILABLE", retryable: failure.retryable ?? true };
  }
  return { code: "OPERATION_FAILED", retryable: failure.retryable ?? false };
};
