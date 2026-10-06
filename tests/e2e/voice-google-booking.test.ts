import { createSocket } from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import { resetCallLiveness } from "../../src/modules/calls/index.js";
import { buildApplication } from "../../src/bootstrap/build-application.js";
import { DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { BusinessDirectoryService, InMemoryBusinessRepository } from "../../src/modules/business/index.js";
import { GoogleCalendarAdapter, BusinessCalendarAssignmentResolver, type GoogleOAuthService } from "../../src/modules/integrations/index.js";
import { ScriptedConversationRuntime, type ToolResultEnvelope } from "../../src/modules/conversation/index.js";
import type { AgentToolName } from "../../src/modules/agents/index.js";
import { AsteriskTelephonyGateway, AsteriskRtpVoiceMediaGateway, type AsteriskMediaClient, type AsteriskEvent } from "../../src/modules/telephony/index.js";
import { createRtpPacket, parseRtpPacket } from "../../src/modules/telephony/infrastructure/asterisk/rtp.js";

class Ari implements AsteriskMediaClient {
  handler?: (event: AsteriskEvent) => Promise<void>;
  answer = vi.fn(async () => {});
  hangup = vi.fn(async () => {});
  transfer = vi.fn(async () => {});
  createMixingBridge = vi.fn(async () => ({ bridgeId: "booking-bridge" }));
  addChannelsToBridge = vi.fn(async () => {});
  destroyBridge = vi.fn(async () => {});
  createExternalMedia = vi.fn(async () => ({ channelId: "booking-external" }));
  onEvent(handler: (event: AsteriskEvent) => Promise<void>) { this.handler = handler; }
  async emit(event: AsteriskEvent) { await this.handler?.(event); }
}

type GoogleEvent = {
  id: string; summary: string; description: string;
  start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string };
  extendedProperties: { private: { yiboAppointmentId: string; yiboTenantId: string } };
};

// Provider responses are synthetic; application services, calendar routing and media are real.
describe("integrated phone booking through Google Calendar", () => {
  it.each([
    { locationId: "default", name: "Central Clinic", zone: "America/Chicago", did: "+15125550100", price: 9500, calendar: "central@example.test", localStart: "2026-09-21T10:30:00-05:00", utcStart: "2026-09-21T15:30:00.000Z", port: 50220 },
    { locationId: "west", name: "West Clinic", zone: "America/Denver", did: "+13035550100", price: 12500, calendar: "west-professional@example.test", localStart: "2026-09-21T10:30:00-06:00", utcStart: "2026-09-21T16:30:00.000Z", port: 50221 },
  ])("books the called $name with its price, timezone and calendar", async (scenario) => {
    resetCallLiveness();
    const profile = structuredClone(DEVELOPMENT_US_BUSINESS);
    profile.locations[0]!.name = "Central Clinic";
    profile.locations[0]!.defaultCalendarId = "central@example.test";
    profile.locations[0]!.services[0]!.price.amountMinor = 9500;
    const west = structuredClone(profile.locations[0]!);
    west.id = "west"; west.name = "West Clinic"; west.timezone = "America/Denver";
    west.calledNumbers = ["+13035550100"]; west.defaultCalendarId = "west-default@example.test";
    west.services[0]!.price.amountMinor = 12500;
    west.professionals[0]!.calendarId = "west-professional@example.test";
    profile.locations.push(west);
    const repository = new InMemoryBusinessRepository([profile]);
    const resolver = new BusinessCalendarAssignmentResolver(new BusinessDirectoryService(repository));
    const events: GoogleEvent[] = [];
    let releaseCreate!: () => void;
    const createResponseReady = new Promise<void>(resolve => { releaseCreate = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access");
      if ((init?.method ?? "GET") === "GET" && url.searchParams.get("privateExtendedProperty")?.startsWith("yiboOperationId=")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      if (url.pathname.endsWith("/freeBusy")) {
        expect(body.items).toEqual([{ id: scenario.calendar }]);
        expect(body.timeZone).toBe(scenario.zone);
        return new Response(JSON.stringify({ calendars: { [scenario.calendar]: { busy: [] } } }));
      }
      expect(url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(scenario.calendar)}/events`);
      events.push(body as GoogleEvent);
      await createResponseReady;
      return new Response(JSON.stringify({ id: body.id }), { status: 201 });
    });
    const accessToken = vi.fn(async (_tenantId: string) => "synthetic-access");
    const oauth = { status: async () => ({ configured: true, connected: true }), accessToken } as unknown as GoogleOAuthService;
    const calendar = new GoogleCalendarAdapter(resolver, oauth, fetcher);
    const ari = new Ari();
    const voice = new AsteriskRtpVoiceMediaGateway(ari, { host: "127.0.0.1", portStart: scenario.port, portEnd: scenario.port, logger: () => {} });
    const telephony = new AsteriskTelephonyGateway(ari, () => "voice-booking-call", voice);
    const runtime = new ScriptedConversationRuntime();
    const app = buildApplication({ environment: {}, tenantId: profile.tenantId, businesses: [profile], businessRepository: repository,
      calendar, runtime, telephonyGateway: telephony, voiceGateway: voice,
      clock: { now: () => new Date("2026-09-17T12:00:00Z") }, ids: { generate: scope => `${scope}-voice-booking` },
    });
    const peer = createSocket("udp4");
    await new Promise<void>(resolve => peer.bind(0, "127.0.0.1", resolve));
    try {
      const config = await app.agentConfiguration.get(profile.tenantId);
      if (!config) throw new Error("Missing agent configuration");
      config.toolPolicies.confirmations.requiredFor = ["create_appointment"];
      await app.agentConfiguration.update(profile.tenantId, config);
      await ari.emit({ type: "CHANNEL_ENTERED_APPLICATION", channelId: "booking-caller", callerNumber: "+12025550199",
        dialedNumber: scenario.did, occurredAt: "2026-09-17T12:00:00Z" });
      expect(runtime.sessions).toHaveLength(1);
      expect(ari.answer).toHaveBeenCalledWith("booking-caller");
      expect(runtime.openedInputs[0]!.agent).toMatchObject({ channel: "phone" });
      expect(runtime.openedInputs[0]!.agent.instructions).toContain(scenario.name);
      expect((await app.callHistory.listByTenant(profile.tenantId, 10))[0]).toMatchObject({ locationId: scenario.locationId, state: "IN_CONVERSATION" });
      const session = runtime.latestSession;
      peer.send(createRtpPacket({ payload: new Uint8Array(160).fill(255), sequenceNumber: 1, timestamp: 1, ssrc: 1, marker: false }), scenario.port, "127.0.0.1");
      await vi.waitFor(() => expect(session.receivedAudio).toHaveLength(1));
      expect(session.receivedAudio[0]).toMatchObject({ codec: "pcm_s16le", sampleRate: 24000, channels: 1 });
      const resultFor = async (toolCallId: string): Promise<ToolResultEnvelope> => {
        await vi.waitFor(() => expect(session.receivedToolResults.some(result => result.toolCallId === toolCallId)).toBe(true));
        return session.receivedToolResults.find(result => result.toolCallId === toolCallId)!;
      };
      const tool = async (toolCallId: string, name: AgentToolName, args: unknown) => {
        session.emit({ type: "tool.call", toolCallId, name, arguments: args });
        return resultFor(toolCallId);
      };
      expect(await tool("catalog", "get_service_information", { service: "Consultation" })).toMatchObject({ ok: true, data: {
        services: [{ name: "Consultation", durationMinutes: 30, locations: expect.arrayContaining([
          { name: scenario.name, price: { amountMinor: scenario.price, currency: "USD", display: expect.any(String) } },
        ]) }],
      } });
      const availability = await tool("availability", "check_availability", { service: "Consultation", employeeId: "employee-us-1",
        rangeStart: "2026-09-21T00:00:00Z", rangeEnd: "2026-09-22T00:00:00Z", requestedStartAt: scenario.localStart });
      expect(availability).toMatchObject({ ok: true, data: { requestedTimeAvailable: true, requestedStartAt: scenario.utcStart } });
      expect(await tool("contact", "update_customer", { name: "Synthetic Patient", phone: "+12025550199" })).toMatchObject({ ok: true });
      const booking = { service: "Consultation", employeeId: "employee-us-1", startAt: scenario.localStart };
      const gate = await tool("request-booking", "create_appointment", booking);
      if (gate.ok || !gate.error.confirmationToken) throw new Error("Expected backend confirmation gate");
      expect(gate.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(events).toHaveLength(0);
      const confirmedArgs = { ...booking, confirmationToken: gate.error.confirmationToken };
      expect(await tool("same-turn", "create_appointment", confirmedArgs)).toMatchObject({ ok: false, error: { code: "CONFIRMATION_PENDING_NEW_TURN" } });
      expect(events).toHaveLength(0);
      session.emit({ type: "user.speech_started" });
      session.emit({ type: "user.speech_stopped" });
      const createCall = { type: "tool.call" as const, toolCallId: "accepted-booking", name: "create_appointment" as const, arguments: confirmedArgs };
      session.emit(createCall);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(session.receivedToolResults.some(result => result.toolCallId === "accepted-booking")).toBe(false);
      expect(await app.appointments.getAppointment({ tenantId: profile.tenantId, locationId: scenario.locationId, appointmentId: "appointment-voice-booking" }))
        .toMatchObject({ ok: true, value: { status: "PENDING_CONFIRMATION" } });
      releaseCreate();
      const confirmed = await resultFor("accepted-booking");
      expect(confirmed).toMatchObject({ ok: true, data: { confirmed: true, startAt: scenario.utcStart,
        timezone: scenario.zone, location: scenario.name, price: { amountMinor: scenario.price, currency: "USD" } } });
      session.emit(createCall); // Duplicate provider delivery must not create another event/result.
      expect(await tool("after-booking", "get_service_information", {})).toMatchObject({ ok: true });
      expect(session.receivedToolResults.filter(result => result.toolCallId === "accepted-booking")).toHaveLength(1);
      expect(events).toHaveLength(1);
      const persisted = await app.appointments.getAppointment({ tenantId: profile.tenantId, locationId: scenario.locationId, appointmentId: "appointment-voice-booking" });
      expect(persisted).toMatchObject({ ok: true, value: { status: "CONFIRMED", locationId: scenario.locationId,
        customerId: "customer-voice-booking", employeeId: "employee-us-1", priceAmountMinor: scenario.price,
        startAt: scenario.utcStart, externalCalendarEventId: events[0]!.id, source: "AI_CALL", sourceCallId: "voice-booking-call" } });
      expect(await app.customers.findOrCreateByPhone({ tenantId: profile.tenantId, phone: "+12025550199" }))
        .toMatchObject({ ok: true, value: { id: "customer-voice-booking", name: "Synthetic Patient" } });
      expect(events[0]).toMatchObject({ summary: "Consultation — Synthetic Patient",
        start: { dateTime: scenario.localStart, timeZone: scenario.zone },
        extendedProperties: { private: { yiboAppointmentId: "appointment-voice-booking", yiboTenantId: profile.tenantId } } });
      expect(Date.parse(events[0]!.end.dateTime) - Date.parse(events[0]!.start.dateTime)).toBe(30 * 60_000);
      expect(accessToken.mock.calls.every(([tenant]) => tenant === profile.tenantId)).toBe(true);
      const output = vi.fn(); peer.on("message", output);
      session.emit({ type: "assistant.response_created", responseId: "final" });
      session.emit({ type: "audio.delta", assistantTurnId: "confirmation-audio", frame: {
        codec: "pcm_s16le", sampleRate: 24000, channels: 1, data: new Uint8Array(1020),
      } });
      await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1));
      expect(parseRtpPacket(output.mock.calls[0]![0])?.payloadType).toBe(0);
      session.emit({ type: "assistant.audio_completed", assistantTurnId: "confirmation-audio" });
      session.emit({ type: "tool.call", toolCallId: "end-call", name: "end_call", arguments: {} });
      session.emit({ type: "assistant.response_done", status: "completed" });
      await vi.waitFor(() => expect(ari.hangup).toHaveBeenCalledWith("booking-caller"));
      expect(output).toHaveBeenCalledTimes(2); // Partial final packet was padded and delivered.
      expect((await resultFor("end-call"))).toMatchObject({ ok: true, data: { ending: true } });
      expect((await app.callHistory.listByTenant(profile.tenantId, 10))[0]!.state).toBe("COMPLETED");
      expect(session.closeCount).toBe(1);
      expect(ari.destroyBridge).toHaveBeenCalledTimes(1);
      expect(ari.hangup).toHaveBeenCalledWith("booking-external");
    } finally { releaseCreate(); await telephony.close(); peer.close(); }
  });
});
