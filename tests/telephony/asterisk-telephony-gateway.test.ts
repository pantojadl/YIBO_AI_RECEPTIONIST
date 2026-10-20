import { describe, expect, it, vi } from "vitest";
import {
  AsteriskTelephonyGateway,
  type AsteriskClient,
  type AsteriskEvent,
  type TelephonyEvent,
} from "../../src/modules/telephony/index.js";

class FakeAsteriskClient implements AsteriskClient {
  readonly answer = vi.fn(async () => {});
  readonly hangup = vi.fn(async () => {});
  readonly transfer = vi.fn(async () => {});
  private handler?: (event: AsteriskEvent) => Promise<void>;

  onEvent(handler: (event: AsteriskEvent) => Promise<void>): void { this.handler = handler; }
  async emit(event: AsteriskEvent): Promise<void> { await this.handler?.(event); }
}

function fixture(options?: { allowExternalTransfer?: boolean; calledNumberRegion?: string }) {
  const client = new FakeAsteriskClient();
  let nextId = 1;
  const gateway = new AsteriskTelephonyGateway(client, () => `call-${nextId++}`, undefined, options);
  const events: TelephonyEvent[] = [];
  gateway.onEvent(async (event) => { events.push(event); });
  return { client, events, gateway };
}

const incoming: AsteriskEvent = {
  type: "CHANNEL_ENTERED_APPLICATION",
  channelId: "asterisk-channel-99",
  callerNumber: "+525555555555",
  dialedNumber: "+525511111111",
  occurredAt: "2026-08-09T12:00:00-06:00",
};

describe("AsteriskTelephonyGateway", () => {
  it("maps an Asterisk channel to a YIBO incoming call event", async () => {
    const { client, events } = fixture();
    await client.emit(incoming);

    expect(events).toEqual([{
      type: "INCOMING_CALL",
      callId: "call-1",
      from: "+525555555555",
      to: "+525511111111",
      occurredAt: "2026-08-09T18:00:00.000Z",
    }]);
  });

  it("uses the provider channel internally for answer and hangup", async () => {
    const { client, gateway } = fixture();
    await client.emit(incoming);

    await expect(gateway.answer("call-1")).resolves.toEqual({ ok: true, value: undefined });
    await expect(gateway.hangup("call-1")).resolves.toEqual({ ok: true, value: undefined });
    expect(client.answer).toHaveBeenCalledWith("asterisk-channel-99");
    expect(client.hangup).toHaveBeenCalledWith("asterisk-channel-99");
  });

  it("refuses an external phone transfer unless the operator enables it", async () => {
    const { client, gateway } = fixture();
    await client.emit(incoming);

    const blocked = await gateway.transfer("call-1", {
      type: "PHONE_NUMBER",
      value: "+52 (55) 1234-5678",
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: "INVALID_DESTINATION" } });
    expect(client.transfer).not.toHaveBeenCalled();

    const allowed = fixture({ allowExternalTransfer: true });
    await allowed.client.emit(incoming);
    await expect(allowed.gateway.transfer("call-1", {
      type: "PHONE_NUMBER",
      value: "+52 (55) 1234-5678",
    })).resolves.toEqual({ ok: true, value: undefined });
    expect(allowed.client.transfer).toHaveBeenCalledWith("asterisk-channel-99", {
      kind: "phone",
      value: "+525512345678",
    });
  });

  it("ignores a duplicate Stasis entry for the same channel", async () => {
    const { client, events } = fixture();
    await client.emit(incoming);
    await client.emit(incoming);
    expect(events).toHaveLength(1);
  });

  it("canonicalizes a 10-digit US called number before tenant lookup", async () => {
    const { client, events } = fixture({ calledNumberRegion: "US" });
    await client.emit({ ...incoming, dialedNumber: "(512) 555-0100" });
    expect(events[0]).toMatchObject({ type: "INCOMING_CALL", to: "+15125550100" });
  });

  it("rejects invalid destinations before calling Asterisk", async () => {
    const { client, gateway } = fixture();
    await client.emit(incoming);

    const result = await gateway.transfer("call-1", { type: "EXTENSION", value: "sip:attacker" });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_DESTINATION" } });
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it("maps DTMF and removes channel mappings after hangup", async () => {
    const { client, events, gateway } = fixture();
    await client.emit(incoming);
    await client.emit({
      type: "DTMF_RECEIVED",
      channelId: "asterisk-channel-99",
      digit: "#",
      occurredAt: "2026-08-09T18:01:00.000Z",
    });
    await client.emit({
      type: "CHANNEL_DESTROYED",
      channelId: "asterisk-channel-99",
      occurredAt: "2026-08-09T18:02:00.000Z",
    });

    expect(events.slice(1)).toEqual([
      { type: "DTMF_RECEIVED", callId: "call-1", digit: "#", occurredAt: "2026-08-09T18:01:00.000Z" },
      { type: "CALL_HUNG_UP", callId: "call-1", occurredAt: "2026-08-09T18:02:00.000Z" },
    ]);
    await expect(gateway.answer("call-1")).resolves.toEqual({ ok: false, error: { code: "CALL_NOT_FOUND" } });
  });

  it("maps provider failures to typed telephony errors", async () => {
    const { client, gateway } = fixture();
    await client.emit(incoming);
    client.answer.mockRejectedValueOnce({ code: "CONNECTION_UNAVAILABLE", retryable: true });

    await expect(gateway.answer("call-1")).resolves.toEqual({
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE", retryable: true },
    });
  });

  it("does not emit provider events for unknown channels", async () => {
    const { client, events } = fixture();
    await client.emit({
      type: "DTMF_RECEIVED",
      channelId: "unknown",
      digit: "1",
      occurredAt: "2026-08-09T18:00:00.000Z",
    });
    expect(events).toEqual([]);
  });
});
