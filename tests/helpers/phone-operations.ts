import { InMemoryAppointmentRepository } from "../../src/modules/appointments/infrastructure/in-memory-appointment-repository.js";
import { expect, vi } from "vitest";
import { buildApplication } from "../../src/bootstrap/build-application.js";
import { DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { BusinessDirectoryService, InMemoryBusinessRepository } from "../../src/modules/business/index.js";
import { GoogleCalendarAdapter, BusinessCalendarAssignmentResolver, type GoogleOAuthService } from "../../src/modules/integrations/index.js";
import { ScriptedConversationRuntime, type ScriptedConversationRuntimeSession } from "../../src/modules/conversation/index.js";
import type { AgentToolName } from "../../src/modules/agents/index.js";
import { resetCallLiveness } from "../../src/modules/calls/index.js";
import { AsteriskTelephonyGateway, AsteriskRtpVoiceMediaGateway, type AsteriskMediaClient, type AsteriskEvent } from "../../src/modules/telephony/index.js";

class Ari implements AsteriskMediaClient {
  handler?: (event: AsteriskEvent) => Promise<void>;
  sequence = 0;
  answer = vi.fn(async (_id: string) => {});
  hangup = vi.fn(async (_id: string) => {});
  transfer = vi.fn(async (_id: string, _target: { kind: "phone" | "extension"; value: string }) => {});
  createMixingBridge = vi.fn(async () => ({ bridgeId: `bridge-${++this.sequence}` }));
  addChannelsToBridge = vi.fn(async (_bridge: string, _channels: string[]) => {});
  destroyBridge = vi.fn(async (_id: string) => {});
  createExternalMedia = vi.fn(async () => ({ channelId: `external-${this.sequence}` }));
  onEvent(handler: (event: AsteriskEvent) => Promise<void>) { this.handler = handler; }
  async emit(event: AsteriskEvent) { await this.handler?.(event); }
}

type Event = { id: string; etag: string; start: { dateTime: string }; end: { dateTime: string }; extendedProperties: unknown };
export const slot = "2026-09-21T15:30:00.000Z";
export const booking = { service: "Consultation", employeeId: "employee-us-1", startAt: slot };
export function phoneOperations(portStart = 50300) {
  // Each fixture numbers calls from operation-call-1. A prior hangup must not
  // block the next fixture's live call.
  resetCallLiveness();
  const profile = structuredClone(DEVELOPMENT_US_BUSINESS);
  profile.locations[0]!.defaultCalendarId = "operations@example.test";
  profile.locations[0]!.transferDestination = { type: "EXTENSION", value: "204" };
  const appointments = new InMemoryAppointmentRepository();
  const repository = new InMemoryBusinessRepository([profile], tenantId => appointments.calendarRouteReferences(tenantId));
  const eventCalendars = new Map<string, string>();
  const events = new Map<string, Event>();
  const controls = { outage: false, writeOutage: false, holdCreate: undefined as Promise<void> | undefined };
  let revision = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (controls.outage) return new Response(null, { status: 503 });
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/freeBusy")) return Response.json({ calendars: { [body.items[0].id]: {
      busy: [...events.values()].filter(event => eventCalendars.get(event.id) === body.items[0].id).map(event => ({ start: event.start.dateTime, end: event.end.dateTime })),
    } } });
    if (controls.writeOutage && ["POST", "PATCH", "DELETE"].includes(method)) return new Response(null, { status: 503 });
    const id = method === "POST" ? body.id : url.pathname.split("/").at(-1)!;
    const calendarId = decodeURIComponent(url.pathname.split("/")[4]!);
    if (method === "POST") {
      await controls.holdCreate;
      if (events.has(id)) return new Response(null, { status: 409 });
      eventCalendars.set(id, calendarId);
      events.set(id, { ...body, etag: String(++revision) });
    } else if (!events.has(id) || eventCalendars.get(id) !== calendarId) return new Response(null, { status: 404 });
    else if (method === "PATCH" || method === "DELETE") {
      if (new Headers(init?.headers).get("if-match") !== events.get(id)!.etag) return new Response(null, { status: 412 });
      if (method === "DELETE") { events.delete(id); return new Response(null, { status: 204 }); }
      events.set(id, { ...events.get(id)!, ...body, etag: String(++revision) });
    }
    return Response.json(events.get(id));
  });
  const oauth = { status: async () => ({ configured: true, connected: true }), accessToken: async () => "synthetic-token" } as unknown as GoogleOAuthService;
  const calendar = new GoogleCalendarAdapter(new BusinessCalendarAssignmentResolver(new BusinessDirectoryService(repository)), oauth, fetcher);
  const ari = new Ari();
  const voice = new AsteriskRtpVoiceMediaGateway(ari, { host: "127.0.0.1", portStart, portEnd: portStart + 3, logger: () => {} });
  let callSequence = 0;
  const telephony = new AsteriskTelephonyGateway(ari, () => `operation-call-${++callSequence}`, voice);
  const runtime = new ScriptedConversationRuntime();
  const app = buildApplication({ environment: {}, tenantId: profile.tenantId, businesses: [profile], businessRepository: repository,
    appointmentRepository: appointments, calendar, runtime, telephonyGateway: telephony, voiceGateway: voice, clock: { now: () => new Date("2026-09-17T12:00:00Z") },
  });
  const hangup = (channelId: string) => ari.emit({ type: "CHANNEL_DESTROYED", channelId, occurredAt: "2026-09-17T12:05:00Z" });
  return { app, appointments, eventCalendars, ari, voice, telephony, runtime, events, controls, fetcher, hangup,
    async start(channelId = "caller-1", phone = "+12025550101") {
      await ari.emit({ type: "CHANNEL_ENTERED_APPLICATION", channelId, callerNumber: phone,
        dialedNumber: profile.locations[0]!.calledNumbers[0]!, occurredAt: "2026-09-17T12:00:00Z" });
      return runtime.latestSession;
    },
    async close() {
      for (let index = 1; index <= callSequence; index++) await hangup(`caller-${index}`);
      await telephony.close();
    },
  };
}
let toolSequence = 0;
export async function tool(session: ScriptedConversationRuntimeSession, name: AgentToolName, args: unknown = {}) {
  const toolCallId = `operation-tool-${++toolSequence}`;
  session.emit({ type: "tool.call", toolCallId, name, arguments: args });
  await vi.waitFor(() => expect(session.receivedToolResults.some(result => result.toolCallId === toolCallId)).toBe(true));
  return session.receivedToolResults.find(result => result.toolCallId === toolCallId)!;
}
export async function available(session: ScriptedConversationRuntimeSession, startAt = slot) {
  return tool(session, "check_availability", { service: "Consultation", employeeId: "employee-us-1",
    rangeStart: "2026-09-21T00:00:00Z", rangeEnd: "2026-09-22T00:00:00Z", requestedStartAt: startAt });
}

export async function confirmContact(session: ScriptedConversationRuntimeSession, suffix = "01") {
  return tool(session, "update_customer", { name: `Synthetic Patient ${suffix}`, phone: `+120255501${suffix}` });
}
