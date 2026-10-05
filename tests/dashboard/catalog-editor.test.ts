import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";
import { createCatalogEditor, copyCatalogValue, parsePrice, priceText } from "../../dashboard/src/services/catalog-editor.js";
import { api } from "../../dashboard/src/services/api.js";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); server = undefined; });
const service = { id: "new-service", name: "Consultation", description: "A scheduled consultation", durationMinutes: 45, bufferMinutes: 10, active: true };
const professional = { id: "new-provider", displayName: "Test Provider", active: true };
async function fixture(roles: Array<"tenant_admin" | "operator"> = ["tenant_admin"]) {
  const app = buildApplication(); server = await createApiServer(app);
  const session = await createAdminTestSession(app, server, roles);
  const requests: Array<{ method: string; url: string; body: any; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = { ...(method === "GET" ? session.readHeaders : session.mutationHeaders), ...Object.fromEntries(new Headers(init?.headers).entries()) };
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    const response = await server!.inject({ method: method as "GET" | "PUT" | "POST", url, headers, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode });
  });
  const editor = createCatalogEditor(); await editor.load();
  return { app, editor, requests };
}

describe("UI-006 catalog editor through existing admin APIs", () => {
  it("creates and updates service details using the guarded catalog endpoint and advancing versions", async () => {
    const { editor, requests, app } = await fixture();
    expect(await editor.saveService(service, true)).toBe(true);
    const updated = { ...service, name: "Follow-up", description: "Updated description", durationMinutes: 20, bufferMinutes: 5 };
    expect(await editor.saveService(updated, false)).toBe(true);
    expect(editor.state.document?.configuration.services.find(item => item.id === service.id)).toEqual(updated);
    expect(editor.state.document?.version).toBe(3);
    const writes = requests.filter(item => item.method !== "GET");
    expect(writes.map(item => [item.method, item.url, item.headers["if-match"]])).toEqual([
      ["POST", "/api/admin/services", '"1"'], ["PUT", "/api/admin/services/new-service", '"2"'],
    ]);
    expect(writes[1]!.body).not.toHaveProperty("id");
    expect(writes[1]!.body).not.toHaveProperty("tenantId");
    expect(await app.adminAudit.listByTenant(app.tenantId)).toHaveLength(2);
  });

  it("sets exact per-location prices and offerings without changing schedules, catalogs or routing", async () => {
    const { editor } = await fixture();
    await editor.saveService(service, true);
    const before = copyCatalogValue(editor.state.document!);
    const location = before.configuration.locations[0]!;
    expect(await editor.saveOffering(location.id, service.id, true, "125.50", "mxn")).toBe(true);
    const after = editor.state.document!;
    expect(after.configuration.locations[0]!.services.at(-1)).toEqual({ serviceId: service.id, active: true, price: { amountMinor: 12550, currency: "MXN" } });
    expect(after.configuration.services).toEqual(before.configuration.services);
    expect(after.configuration.professionals).toEqual(before.configuration.professionals);
    const { services: _beforeServices, ...unchangedBefore } = location;
    const { services: _afterServices, ...unchangedAfter } = after.configuration.locations[0]!;
    expect(unchangedAfter).toEqual(unchangedBefore);
    expect(await editor.saveOffering(location.id, service.id, false, "125.50", "MXN")).toBe(true);
  });

  it("keeps the default service offering active when the backend rejects disabling it", async () => {
    const { editor } = await fixture();
    const before = copyCatalogValue(editor.state.document!);
    const location = before.configuration.locations[0]!;
    expect(await editor.saveOffering(location.id, location.policies.defaultServiceId, false, "10", "USD")).toBe(false);
    expect(editor.state.document).toEqual(before);
  });

  it("creates a professional, assigns services and hours, then restores inherited location hours", async () => {
    const { editor, requests } = await fixture();
    expect(await editor.saveProfessional(professional, true)).toBe(true);
    expect(await editor.saveProfessional({ ...professional, displayName: "Updated Provider" }, false)).toBe(true);
    const location = editor.state.document!.configuration.locations[0]!;
    const assignment = { professionalId: professional.id, active: true, serviceIds: [location.services[0]!.serviceId], openingHours: [{ dayOfWeek: 1 as const, startTime: "10:00", endTime: "13:00" }] };
    expect(await editor.saveAssignment(location.id, assignment)).toBe(true);
    expect(editor.state.document!.configuration.locations[0]!.professionals.at(-1)).toEqual(assignment);
    expect(await editor.saveAssignment(location.id, { ...assignment, openingHours: [] })).toBe(true);
    expect(editor.state.document!.configuration.locations[0]!.professionals.at(-1)!.openingHours).toEqual([]);
    const write = requests.at(-1)!;
    expect(write.url).toContain(`/locations/${location.id}/professionals/new-provider`);
    expect(write.body).not.toHaveProperty("professionalId");
  });

  it("retains saved calendar routing even if the assignment form supplies another calendar", async () => {
    const { app, editor, requests } = await fixture();
    const document = copyCatalogValue(editor.state.document!);
    const location = document.configuration.locations[0]!;
    const assignment = location.professionals[0]!;
    assignment.calendarId = "existing-calendar@example.com";
    await app.business.updateBusinessConfiguration(app.tenantId, document.configuration, document.version);
    await editor.load();
    expect(await editor.saveAssignment(location.id, { ...assignment, calendarId: "unwanted@example.com", openingHours: [] })).toBe(true);
    expect(requests.at(-1)!.body.calendarId).toBe("existing-calendar@example.com");
  });

  it("respects service and professional in-use protections instead of replacing the full catalog", async () => {
    const { editor } = await fixture();
    const document = copyCatalogValue(editor.state.document!);
    expect(await editor.saveService({ ...document.configuration.services[0]!, active: false }, false)).toBe(false);
    expect(editor.state.error).toContain("in use");
    expect(await editor.saveProfessional({ ...document.configuration.professionals[0]!, active: false }, false)).toBe(false);
    expect(editor.state.error).toContain("in use");
    expect(editor.state.document).toEqual(document);
  });

  it("supports activating and deactivating unassigned catalog records", async () => {
    const { editor } = await fixture();
    await editor.saveService({ ...service, active: false }, true);
    expect(await editor.saveService(service, false)).toBe(true);
    expect(await editor.saveService({ ...service, active: false }, false)).toBe(true);
    await editor.saveProfessional({ ...professional, active: false }, true);
    expect(await editor.saveProfessional(professional, false)).toBe(true);
    expect(await editor.saveProfessional({ ...professional, active: false }, false)).toBe(true);
  });

  it("blocks stale writes without retrying and requires an explicit reload", async () => {
    const { editor, app, requests } = await fixture();
    const document = copyCatalogValue(editor.state.document!);
    await app.business.updateBusinessConfiguration(app.tenantId, { ...document.configuration, name: "New server name" }, document.version);
    const draft = copyCatalogValue(service);
    expect(await editor.saveService(draft, true)).toBe(false);
    expect(editor.state.conflict).toBe(true);
    expect(draft).toEqual(service);
    const count = requests.length;
    await editor.saveService(draft, true);
    expect(requests).toHaveLength(count);
    await editor.load();
    expect(editor.state.conflict).toBe(false);
    expect(await editor.saveService(draft, true)).toBe(true);
  });

  it("rejects invalid duration, hours and service eligibility without updating local state", async () => {
    const { editor } = await fixture();
    const document = copyCatalogValue(editor.state.document!);
    expect(await editor.saveService({ ...service, durationMinutes: 0 }, true)).toBe(false);
    const location = document.configuration.locations[0]!;
    const assignment = location.professionals[0]!;
    expect(await editor.saveAssignment(location.id, { ...assignment, openingHours: [{ dayOfWeek: 1, startTime: "18:00", endTime: "09:00" }] })).toBe(false);
    expect(await editor.saveAssignment(location.id, { ...assignment, serviceIds: ["unknown-service"] })).toBe(false);
    expect(editor.state.document).toEqual(document);
  });

  it("changes only the selected location's price and professional assignment", async () => {
    const { editor, app } = await fixture();
    const document = copyCatalogValue(editor.state.document!);
    const second = copyCatalogValue(document.configuration.locations[0]!);
    second.id = "south"; second.name = "South"; second.active = false; second.calledNumbers = [];
    document.configuration.locations.push(second);
    await app.business.updateBusinessConfiguration(app.tenantId, document.configuration, document.version);
    await editor.load();
    const firstBefore = copyCatalogValue(editor.state.document!.configuration.locations[0]!);
    expect(await editor.saveOffering("south", second.services[0]!.serviceId, true, "99.25", "USD")).toBe(true);
    expect(await editor.saveAssignment("south", { ...second.professionals[0]!, openingHours: [{ dayOfWeek: 2, startTime: "11:00", endTime: "14:00" }] })).toBe(true);
    expect(editor.state.document!.configuration.locations[0]).toEqual(firstBefore);
    expect(editor.state.document!.configuration.locations[1]!.services[0]!.price).toEqual({ amountMinor: 9925, currency: "USD" });
    expect(editor.state.document!.configuration.locations[1]!.professionals[0]!.openingHours[0]!.dayOfWeek).toBe(2);
  });

  it("keeps trusted tenant selectors out of accepted catalog mutations", async () => {
    await fixture();
    await expect(api.createService({ ...service, tenantId: "other-tenant" } as never, 1)).rejects.toMatchObject({ status: 400, code: "UNTRUSTED_TENANT_SELECTOR" });
  });

  it("rejects a stale price edit without overwriting newer location routing", async () => {
    const { editor, app } = await fixture();
    const document = copyCatalogValue(editor.state.document!);
    const location = document.configuration.locations[0]!;
    location.defaultCalendarId = "new-route@example.com";
    await app.business.updateBusinessConfiguration(app.tenantId, document.configuration, document.version);
    expect(await editor.saveOffering(location.id, location.services[0]!.serviceId, true, "55.00", "USD")).toBe(false);
    expect(editor.state.conflict).toBe(true);
    await editor.load();
    expect(editor.state.document!.configuration.locations[0]!.defaultCalendarId).toBe("new-route@example.com");
    expect(editor.state.document!.configuration.locations[0]!.services).toEqual(location.services);
  });

  it("disables and restores an unused provider assignment while retaining its services and hours", async () => {
    const { editor } = await fixture();
    await editor.saveProfessional(professional, true);
    const location = editor.state.document!.configuration.locations[0]!;
    const assignment = { professionalId: professional.id, active: true, serviceIds: [location.services[0]!.serviceId], openingHours: [{ dayOfWeek: 2 as const, startTime: "10:00", endTime: "12:00" }] };
    expect(await editor.saveAssignment(location.id, assignment)).toBe(true);
    expect(await editor.saveAssignment(location.id, { ...assignment, active: false })).toBe(true);
    await editor.load();
    expect(editor.state.document!.configuration.locations[0]!.professionals.at(-1)).toEqual({ ...assignment, active: false });
    expect(await editor.saveAssignment(location.id, assignment)).toBe(true);
  });

  it("denies operators access to catalogs and writes", async () => {
    const { editor } = await fixture(["operator"]);
    expect(editor.state.document).toBeUndefined();
    await expect(api.createService(service, 1)).rejects.toMatchObject({ status: 403 });
    await expect(api.createProfessional(professional, 1)).rejects.toMatchObject({ status: 403 });
  });
});

describe("catalog prices use exact integer minor units", () => {
  it.each([["125.50", "USD", 12550], ["125", "JPY", 125], ["1.234", "KWD", 1234], ["0.01", "MXN", 1], ["90071992547409.91", "USD", Number.MAX_SAFE_INTEGER]] as const)("round trips %s %s exactly", (amount, currency, expected) => {
    expect(parsePrice(amount, currency)).toEqual({ amountMinor: expected, currency });
    expect(priceText({ amountMinor: expected, currency })).toBe(amount);
  });
  it.each([["1.001", "USD"], ["-1", "MXN"], ["1.1", "JPY"], ["1", "BAD"], ["1e4", "USD"], ["90071992547409.92", "USD"]])("rejects invalid price %s %s", (amount, currency) => {
    expect(() => parsePrice(amount!, currency!)).toThrow();
  });
});

describe("Checkpoint A default display currency", () => {
  it.each(["USD", "MXN", "EUR"] as const)("persists %s through the versioned admin API without changing existing prices", async currency => {
    const { editor, requests } = await fixture();
    const before = copyCatalogValue(editor.state.document!);
    expect(await editor.saveDisplayCurrency(currency)).toBe(true);
    expect(editor.state.document!.configuration.displayCurrency).toBe(currency);
    expect(editor.state.document!.configuration.locations).toEqual(before.configuration.locations);
    expect(editor.state.document!.version).toBe(before.version + 1);
    expect(requests.at(-1)!.headers["if-match"]).toBe(`"${before.version}"`);
    await editor.load(); expect(editor.state.document!.configuration.displayCurrency).toBe(currency);
  });
  it("rejects unsupported currencies and operator writes", async () => {
    const { editor } = await fixture();
    expect(await editor.saveDisplayCurrency("CAD" as "USD")).toBe(false);
    await server!.close();
    const operator = await fixture(["operator"]);
    expect(await operator.editor.saveDisplayCurrency("EUR")).toBe(false);
  });
});
