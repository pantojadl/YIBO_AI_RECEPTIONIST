import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/index.js";
import { createAdminTestSession } from "../helpers/admin-session.js";
import { createLocationEditor, newLocation, updateAvailabilitySuggestions } from "../../dashboard/src/services/location-editor.js";
import type { FastifyInstance } from "fastify";

let server: FastifyInstance | undefined;
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); });
async function fixture(roles: Array<"tenant_admin" | "operator"> = ["tenant_admin"]) {
  const app = buildApplication();
  server = await createApiServer(app);
  const session = await createAdminTestSession(app, server, roles);
  const requests: Array<{ method: string; body: any; headers: any }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = { ...(method === "GET" ? session.readHeaders : session.mutationHeaders), ...Object.fromEntries(new Headers(init?.headers).entries()) };
    requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    const response = await server!.inject({ method: method as "GET" | "PUT", url, headers, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode });
  });
  const editor = createLocationEditor();
  await editor.load();
  return { app, editor, requests };
}

describe("UI-005 location editor through the authenticated versioned API", () => {
  it("loads and saves location fields while retaining catalogs and calendar/professional assignments", async () => {
    const { editor, app, requests } = await fixture();
    expect(editor.dirty.value).toBe(false);
    const draft = editor.state.draft!;
    const unchanged = JSON.stringify({ services: draft.services, professionals: draft.professionals,
      assignments: draft.locations[0]!.professionals, prices: draft.locations[0]!.services });
    const location = draft.locations[0]!;
    location.name = "North clinic";
    location.address.line1 = "200 Main Street";
    location.timezone = "America/Denver";
    location.calledNumbers = ["+19155550123"];
    location.openingHours = [{ dayOfWeek: 1, startTime: "08:00", endTime: "12:00" }, { dayOfWeek: 1, startTime: "13:00", endTime: "17:00" }];
    location.closures = [{ id: "holiday", startLocal: "2026-12-25T00:00", endLocal: "2026-12-26T00:00", administrativeReason: "Holiday" }];
    location.policies.minimumLeadTimeMinutes = 120;
    location.transferDestination = { type: "EXTENSION", value: "204" };
    expect(editor.dirty.value).toBe(true);
    expect(await editor.save()).toBe(true);
    expect(editor.dirty.value).toBe(false);
    expect(editor.state.version).toBe(2);
    expect(editor.state.draft!.locations[0]).toEqual(location);
    const after = editor.state.draft!;
    expect(JSON.stringify({ services: after.services, professionals: after.professionals,
      assignments: after.locations[0]!.professionals, prices: after.locations[0]!.services })).toBe(unchanged);
    const write = requests.find(({ method }) => method === "PUT")!;
    expect(write.headers["if-match"]).toBe('"1"');
    expect(write.body.configuration).not.toHaveProperty("tenantId");
    expect(write.body.configuration).not.toHaveProperty("region");
    expect(write.body.configuration).not.toHaveProperty("businessId");
    expect(await app.adminAudit.listByTenant(app.tenantId)).toHaveLength(1);
  });

  it("retains a stale draft, blocks retries, and explicitly reloads the latest version", async () => {
    const { editor, app, requests } = await fixture();
    const current = await app.business.getBusinessConfiguration(app.tenantId);
    if (!current.ok) throw new Error("missing configuration");
    current.value.configuration.locations[0]!.name = "Changed elsewhere";
    await app.business.updateBusinessConfiguration(app.tenantId, current.value.configuration, current.value.version);
    editor.state.draft!.locations[0]!.name = "My draft";
    expect(await editor.save()).toBe(false);
    expect(editor.state.conflict).toBe(true);
    expect(editor.state.draft!.locations[0]!.name).toBe("My draft");
    const attempts = requests.length;
    await editor.save();
    expect(requests).toHaveLength(attempts);
    await editor.load();
    expect(editor.state.conflict).toBe(false);
    expect(editor.state.version).toBe(2);
    expect(editor.state.draft!.locations[0]!.name).toBe("Changed elsewhere");
  });

  it.each([
    ["time zone", (location: any) => { location.timezone = "Invalid/Zone"; }],
    ["hours", (location: any) => { location.openingHours = [{ dayOfWeek: 1, startTime: "17:00", endTime: "09:00" }]; }],
    ["closure", (location: any) => { location.closures = [{ id: "x", startLocal: "2026-12-26T00:00", endLocal: "2026-12-25T00:00", administrativeReason: "Holiday" }]; }],
    ["policy", (location: any) => { location.policies.concurrentCapacity = 0; }],
    ["transfer", (location: any) => { location.transferDestination = { type: "EXTENSION", value: "invalid" }; }],
  ] as const)("keeps invalid %s edits without persisting them", async (_, mutate) => {
    const { editor, app } = await fixture();
    mutate(editor.state.draft!.locations[0]);
    const draft = JSON.stringify(editor.state.draft);
    expect(await editor.save()).toBe(false);
    expect(JSON.stringify(editor.state.draft)).toBe(draft);
    expect(editor.state.error).toContain("not saved");
    expect(await app.business.getBusinessConfiguration(app.tenantId)).toMatchObject({ ok: true, value: { version: 1 } });
  });

  it("creates an inactive location without copying phone, professional or calendar routes", async () => {
    const { editor } = await fixture();
    const source = editor.state.draft!.locations[0]!;
    const added = newLocation(source, "north");
    added.name = "North"; added.address.line1 = "200 Main"; added.address.city = "El Paso";
    editor.state.draft!.locations.push(added);
    expect(added).toMatchObject({ active: false, calledNumbers: [], professionals: [], closures: [] });
    expect(added.defaultCalendarId).toBeUndefined();
    expect(added.services).not.toBe(source.services);
    expect(await editor.save()).toBe(true);
    added.active = true; added.calledNumbers = [...source.calledNumbers];
    editor.state.draft!.locations[1] = added;
    expect(await editor.save()).toBe(false);
  });

  it("denies an operator access through the same API used by the editor", async () => {
    const { editor } = await fixture(["operator"]);
    expect(editor.state.draft).toBeUndefined();
    expect(editor.canSave.value).toBe(false);
    expect(editor.state.error).toContain("access");
  });
});

describe("Checkpoint C availability suggestion settings", () => {
  it("uses the existing defaults and saves, reloads and disables the selected location's policy without changing routing", async () => {
    const { editor, requests } = await fixture();
    const before = JSON.parse(JSON.stringify(editor.state.draft!));
    expect(editor.state.draft!.locations[0]!.policies.availabilitySuggestions).toBeUndefined();
    updateAvailabilitySuggestions(editor.state.draft!.locations[0]!, { enabled: true });
    expect(editor.state.draft!.locations[0]!.policies.availabilitySuggestions).toEqual({ enabled: true, expansionDays: 1, maximumAlternatives: 3 });
    updateAvailabilitySuggestions(editor.state.draft!.locations[0]!, { expansionDays: 4, maximumAlternatives: 5 });
    expect(editor.dirty.value).toBe(true); expect(await editor.save()).toBe(true); await editor.load();
    expect(editor.state.draft!.locations[0]!.policies.availabilitySuggestions).toEqual({ enabled: true, expansionDays: 4, maximumAlternatives: 5 });
    updateAvailabilitySuggestions(editor.state.draft!.locations[0]!, { enabled: false });
    expect(await editor.save()).toBe(true);
    const after = JSON.parse(JSON.stringify(editor.state.draft!));
    expect(after.locations[0].policies.availabilitySuggestions).toEqual({ enabled: false, expansionDays: 4, maximumAlternatives: 5 });
    delete after.locations[0].policies.availabilitySuggestions;
    expect(after).toEqual(before);
    expect(requests.filter(item => item.method === "PUT").map(item => item.headers["if-match"])).toEqual(['"1"', '"2"']);
  });

  it.each([{ expansionDays: 0 }, { maximumAlternatives: 6 }])("retains invalid suggestion edits without saving %j", async patch => {
    const { editor, app } = await fixture();
    updateAvailabilitySuggestions(editor.state.draft!.locations[0]!, { enabled: true, ...patch });
    expect(await editor.save()).toBe(false); expect(editor.dirty.value).toBe(true);
    expect(await app.business.getBusinessConfiguration(app.tenantId)).toMatchObject({ ok: true, value: { version: 1 } });
  });

  it("does not share nested suggestion settings between a copied location and its source", async () => {
    const { editor } = await fixture(); const source = editor.state.draft!.locations[0]!;
    updateAvailabilitySuggestions(source, { enabled: true });
    const added = newLocation(source, "new-location");
    added.policies.availabilitySuggestions!.expansionDays = 7;
    expect(source.policies.availabilitySuggestions!.expansionDays).toBe(1);
  });
});


describe("launch integration location defaults", () => {
  it("opens legacy settings without phantom unsaved changes and preserves explicit restrictions after save/reload", async () => {
    const { editor, requests } = await fixture();
    const location = editor.state.draft!.locations[0]!;
    expect(location.policies).toMatchObject({ sameDayBooking: true, cancellationAllowed: true,
      reschedulingAllowed: true, staffOverrideAllowed: false });
    expect(location.aiCapabilities).toMatchObject({ collectEmail: false, quotePrices: true, afterHoursBehavior: "INFORMATION_ONLY" });
    expect(editor.dirty.value).toBe(false);
    expect(requests.every(request => request.method === "GET")).toBe(true);
    location.policies.cancellationAllowed = false;
    location.aiCapabilities!.quotePrices = false;
    expect(editor.dirty.value).toBe(true);
    expect(await editor.save()).toBe(true);
    await editor.load();
    expect(editor.dirty.value).toBe(false);
    expect(editor.state.draft!.locations[0]!.policies.cancellationAllowed).toBe(false);
    expect(editor.state.draft!.locations[0]!.aiCapabilities!.quotePrices).toBe(false);
  });
});
