import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentConcurrencyGuard } from "../../src/infrastructure/database/sqlite-appointment-concurrency-guard.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";
import {
  BusinessDirectoryService,
  InMemoryBusinessRepository,
  type BusinessProfile,
} from "../../src/modules/business/index.js";
import { AppointmentServiceImpl, type CustomerReader } from "../../src/modules/appointments/index.js";
import type { SchedulingService } from "../../src/modules/scheduling/index.js";
import { GoogleCalendarAdapter, type GoogleOAuthService } from "../../src/modules/integrations/index.js";
import { success } from "../../src/shared/domain/result.js";

/**
 * Codex lost-update interleaving on 888f100:
 * writer A blocks inside the reschedule re-fetch, the lease expires, writer B
 * steals the fence and commits another time, then A reads B's etag and PATCHes
 * over that event. Google and the committed row must stay the same time.
 */
const business: BusinessProfile = {
  region: "MX",
  tenantId: "tenant-a",
  businessId: "business-a",
  name: "YIBO Test Business",
  timezone: "America/Mexico_City",
  locale: "es-MX",
  active: true,
  calledNumbers: ["+525555555555"],
  services: [{ id: "service-1", name: "Consultation", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["employee-1"] }],
  employees: [{ id: "employee-1", displayName: "Ana", active: true }],
  openingHours: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
};

const customers: CustomerReader = {
  exists: async (tenantId, customerId) => tenantId === "tenant-a" && customerId === "customer-1",
  get: async () => ({ name: "John Smith", phone: "9155551234" }),
};

const scheduling: SchedulingService = {
  findAvailableSlots: async () => success([]),
  validateSlot: async (query) => success({
    employeeId: query.employeeId,
    startAt: new Date(query.startAt).toISOString(),
    endAt: new Date(new Date(query.startAt).valueOf() + 30 * 60_000).toISOString(),
    validatedAt: "2026-08-09T12:00:00.000Z",
  }),
};

const directory = mkdtempSync(join(tmpdir(), "yibo-etag-fence-"));
const database = openRegionalDatabase("MX", join(directory, "mx.sqlite"));
try {
  migrateDatabase(database);
  database.prepare("INSERT INTO businesses(region_id, tenant_id, business_id, profile_json) VALUES ('MX', 'tenant-a', 'business-a', '{}')").run();
  database.prepare("INSERT INTO customers(region_id, tenant_id, id, phone) VALUES ('MX', 'tenant-a', 'customer-1', '+529990000001')").run();

    const events = new Map<string, Record<string, unknown>>();
    let revision = 0;
    let eventGets = 0;
  let patches = 0;
    let releaseStaleRead: () => void = () => undefined;
  const staleRead = new Promise<void>((resolve) => { releaseStaleRead = resolve; });
  let markStaleRead: () => void = () => undefined;
  const staleReadStarted = new Promise<void>((resolve) => { markStaleRead = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      const eventUrl = /\/events\/[^/?]+$/.test(url);
    if (method === "GET" && eventUrl) {
      eventGets += 1;
      if (eventGets === 2) {
        markStaleRead();
        await staleRead;
      }
      const id = decodeURIComponent(url.split("/events/")[1] ?? "");
      const found = events.get(id);
      return found ? new Response(JSON.stringify(found)) : new Response(null, { status: 404 });
    }
    if (method === "POST" && body) {
      const id = String(body.id);
      events.set(id, { ...body, id, etag: `W/${++revision}`, status: "confirmed" });
      return new Response(JSON.stringify(events.get(id)), { status: 200 });
    }
    if (method === "PATCH" || method === "DELETE") {
      if (method === "PATCH") patches += 1;
      const id = decodeURIComponent(url.split("/events/")[1] ?? "");
      const current = events.get(id);
      if (!current) return new Response(null, { status: 404 });
      const match = new Headers(init?.headers).get("if-match");
      if (match !== current.etag) return new Response(null, { status: 412 });
      if (method === "DELETE") {
        events.delete(id);
        return new Response(null, { status: 204 });
      }
      events.set(id, { ...current, ...body, id, etag: `W/${++revision}`, status: "confirmed" });
      return new Response(JSON.stringify(events.get(id)), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  const oauth = {
    status: async () => ({ configured: true, connected: true }),
    accessToken: async () => "test-access-token",
  } as unknown as GoogleOAuthService;
  const calendar = new GoogleCalendarAdapter({
    resolve: async () => ({ ok: true, value: { calendarId: "clinic@example.com", timezone: "America/Mexico_City", source: "location" } }),
  }, oauth, fetcher);
  const clock = { ms: 1_000_000 };
  const guard = new SqliteAppointmentConcurrencyGuard(database, "MX", {
    now: () => clock.ms,
    leaseMs: 1_000,
    heartbeatMs: 60 * 60_000,
  });
  const repository = new SqliteAppointmentRepository(database, "MX");
  const service = new AppointmentServiceImpl(
    repository,
    customers,
    new BusinessDirectoryService(new InMemoryBusinessRepository([business])),
    scheduling,
    calendar,
    guard,
    (() => { let n = 0; return () => `id-${++n}`; })(),
    { now: () => new Date("2026-08-01T00:00:00.000Z") },
  );
  const created = await service.createAppointment({
    tenantId: "tenant-a", locationId: "default", customerId: "customer-1", serviceId: "service-1",
    employeeId: "employee-1", startAt: "2026-08-10T15:00:00.000Z", idempotencyKey: "book-1", source: "DASHBOARD",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error("create failed");
  const appointmentId = created.value.id;

  const writerB = "2026-08-12T16:00:00.000Z";
  const stale = service.rescheduleAppointment({
    tenantId: "tenant-a", locationId: "default", appointmentId,
    startAt: "2026-08-11T16:00:00.000Z", idempotencyKey: "move-a",
  });
  await staleReadStarted;
  clock.ms += 5_000;
  const committed = await service.rescheduleAppointment({
    tenantId: "tenant-a", locationId: "default", appointmentId,
    startAt: writerB, idempotencyKey: "move-b",
  });
  releaseStaleRead();
  const staleResult = await stale;
  await service.recoverStuckBookings("tenant-a");

  const row = await repository.findById("tenant-a", appointmentId);
  const event = [...events.values()][0] as { start?: { dateTime?: string } } | undefined;
  const googleMs = Date.parse(event?.start?.dateTime ?? "");
  const rowMs = Date.parse(row?.startAt ?? "");
  assert.equal(googleMs, rowMs, `Google ${event?.start?.dateTime} diverged from row ${row?.startAt}`);
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.equal(committed.error.code, "APPOINTMENT_OPERATION_IN_PROGRESS");
  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) assert.equal(staleResult.error.code, "NEEDS_RECONCILE");
  assert.equal(row?.operationIntent, "RESCHEDULING");
  assert.equal(row?.intentKey, "move-a");
  assert.ok(row?.intentEtag);
  assert.equal(patches, 0);
  console.log(JSON.stringify({
    aligned: true,
    rowStartAt: row?.startAt,
    googleStartAt: event?.start?.dateTime,
    writerBCommitted: committed.ok,
    staleCode: staleResult.ok ? "ok" : staleResult.error.code,
    patches,
  }));
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
