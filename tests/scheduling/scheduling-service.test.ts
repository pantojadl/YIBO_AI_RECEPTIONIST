import { describe, expect, it } from "vitest";
import {
  BusinessDirectoryService,
  InMemoryBusinessRepository,
  upgradeBusinessProfile,
  type BusinessProfile,
  type VersionedBusinessProfile,
} from "../../src/modules/business/index.js";
import { failure, success } from "../../src/shared/domain/result.js";
import { SchedulingServiceImpl, type CalendarPort, type ConfirmedAppointmentReader, type EmployeeWorkingHoursProvider } from "../../src/modules/scheduling/index.js";

const business: BusinessProfile = {
  region: "US",
  tenantId: "tenant-smileline", businessId: "business-smileline", name: "SmileLine Dental",
  timezone: "America/Denver", locale: "en-US", active: true, calledNumbers: ["+13035550123"],
  employees: [{ id: "dr-lee", displayName: "Dr. Lee", active: true }],
  services: [{ id: "cleaning", name: "Cleaning", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["dr-lee"] }],
  openingHours: [{ dayOfWeek: 1, startTime: "09:00", endTime: "12:00" }],
};

const workingHours: EmployeeWorkingHoursProvider = {
  getWorkingHours: async () => [{ dayOfWeek: 1, startTime: "09:30", endTime: "11:30" }],
};

const noAppointments: ConfirmedAppointmentReader = {
  findConfirmedIntervals: async () => [],
  findConfirmedLocationIntervals: async () => [],
};
const noCalendarConflicts: CalendarPort = { getBusyIntervals: async () => success([]) };
const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };

const createService = (
  appointments = noAppointments,
  calendar = noCalendarConflicts,
  hours = workingHours,
  profile: VersionedBusinessProfile = business,
) => new SchedulingServiceImpl(
  new BusinessDirectoryService(new InMemoryBusinessRepository([profile])), hours, appointments, calendar, clock,
);

describe("SchedulingService", () => {
  it("returns slots only in the intersection of business and employee hours", async () => {
    const result = await createService().findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    });

    expect(result).toEqual({ ok: true, value: [
      { employeeId: "dr-lee", startAt: "2026-08-10T15:30:00.000Z", endAt: "2026-08-10T16:00:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T15:45:00.000Z", endAt: "2026-08-10T16:15:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T16:00:00.000Z", endAt: "2026-08-10T16:30:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T16:15:00.000Z", endAt: "2026-08-10T16:45:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T16:30:00.000Z", endAt: "2026-08-10T17:00:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T16:45:00.000Z", endAt: "2026-08-10T17:15:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T17:00:00.000Z", endAt: "2026-08-10T17:30:00.000Z" },
    ] });
  });

  it("rejects a slot that overlaps a local confirmed appointment", async () => {
    const appointments: ConfirmedAppointmentReader = {
      findConfirmedIntervals: async () => [{ startAt: "2026-08-10T16:00:00.000Z", endAt: "2026-08-10T16:30:00.000Z" }],
      findConfirmedLocationIntervals: async () => [{ startAt: "2026-08-10T16:00:00.000Z", endAt: "2026-08-10T16:30:00.000Z" }],
    };
    await expect(createService(appointments).validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee", startAt: "2026-08-10T16:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "SLOT_CONFLICT" } });
  });

  it("rejects an external calendar outage with a retryable typed error", async () => {
    const calendar: CalendarPort = { getBusyIntervals: async () => ({ ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true } }) };
    await expect(createService(noAppointments, calendar).validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee", startAt: "2026-08-10T16:30:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "EXTERNAL_CALENDAR_UNAVAILABLE", retryable: true } });
  });

  it("does not accept a slot outside the employee's working hours", async () => {
    await expect(createService().validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee", startAt: "2026-08-10T15:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "OUTSIDE_BUSINESS_HOURS" } });
  });

  it("inherits location hours when no professional override is configured", async () => {
    const inheritedHours: EmployeeWorkingHoursProvider = { getWorkingHours: async () => [] };
    const result = await createService(noAppointments, noCalendarConflicts, inheritedHours).findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    });
    expect(result.ok && result.value[0]?.startAt).toBe("2026-08-10T15:00:00.000Z");
    expect(result.ok && result.value.at(-1)?.endAt).toBe("2026-08-10T18:00:00.000Z");
  });

  it("intersects each location and professional interval without spanning gaps", async () => {
    const splitHours: EmployeeWorkingHoursProvider = {
      getWorkingHours: async () => [
        { dayOfWeek: 1, startTime: "08:00", endTime: "10:00" },
        { dayOfWeek: 1, startTime: "11:00", endTime: "13:00" },
      ],
    };
    const result = await createService(noAppointments, noCalendarConflicts, splitHours).findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    });
    if (!result.ok) throw new Error("Expected slots");
    expect(result.value.map(({ startAt }) => startAt)).toEqual([
      "2026-08-10T15:00:00.000Z", "2026-08-10T15:15:00.000Z", "2026-08-10T15:30:00.000Z",
      "2026-08-10T17:00:00.000Z", "2026-08-10T17:15:00.000Z", "2026-08-10T17:30:00.000Z",
    ]);
  });

  it("excludes local closure ranges without exposing their administrative reason", async () => {
    const closedBusiness = upgradeBusinessProfile(business);
    closedBusiness.locations[0]!.closures = [{
      id: "closure-training",
      startLocal: "2026-08-10T10:00",
      endLocal: "2026-08-10T11:00",
      administrativeReason: "Private staff matter",
    }];
    const service = createService(noAppointments, noCalendarConflicts, workingHours, closedBusiness);
    const result = await service.findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    });
    if (!result.ok) throw new Error("Expected availability result");
    expect(result.value).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ startAt: "2026-08-10T16:00:00.000Z" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("Private staff matter");

    await expect(service.validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning",
      employeeId: "dr-lee", startAt: "2026-08-10T16:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "SLOT_CONFLICT" } });
  });

  it("applies slot increment and maximum results from the location policy", async () => {
    const configured = upgradeBusinessProfile(business);
    configured.locations[0]!.policies.slotIncrementMinutes = 10;
    configured.locations[0]!.policies.maximumResults = 3;
    const result = await createService(noAppointments, noCalendarConflicts, workingHours, configured).findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z", limit: 100,
    });
    expect(result).toEqual({ ok: true, value: [
      { employeeId: "dr-lee", startAt: "2026-08-10T15:30:00.000Z", endAt: "2026-08-10T16:00:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T15:40:00.000Z", endAt: "2026-08-10T16:10:00.000Z" },
      { employeeId: "dr-lee", startAt: "2026-08-10T15:50:00.000Z", endAt: "2026-08-10T16:20:00.000Z" },
    ] });
  });

  it("applies lead time and booking horizon to listing and revalidation", async () => {
    const configured = upgradeBusinessProfile(business);
    configured.locations[0]!.policies.minimumLeadTimeMinutes = 10 * 24 * 60;
    configured.locations[0]!.policies.maximumBookingHorizonDays = 20;
    const service = createService(noAppointments, noCalendarConflicts, workingHours, configured);
    await expect(service.findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    })).resolves.toEqual({ ok: true, value: [] });
    await expect(service.validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning",
      employeeId: "dr-lee", startAt: "2026-08-10T16:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "OUTSIDE_BOOKING_WINDOW" } });

    configured.locations[0]!.policies.minimumLeadTimeMinutes = 0;
    configured.locations[0]!.policies.maximumBookingHorizonDays = 5;
    const horizonService = createService(noAppointments, noCalendarConflicts, workingHours, configured);
    await expect(horizonService.validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning",
      employeeId: "dr-lee", startAt: "2026-08-10T16:00:00.000Z",
    })).resolves.toEqual({ ok: false, error: { code: "OUTSIDE_BOOKING_WINDOW" } });
  });

  it("applies location capacity in addition to professional capacity one", async () => {
    const configured = upgradeBusinessProfile(business);
    configured.professionals.push({ id: "dr-other", displayName: "Dr. Other", active: true });
    configured.locations[0]!.professionals.push({
      professionalId: "dr-other", active: true, serviceIds: ["cleaning"], openingHours: [],
    });
    const locationAppointments: ConfirmedAppointmentReader = {
      findConfirmedIntervals: async () => [],
      findConfirmedLocationIntervals: async () => [{
        startAt: "2026-08-10T15:30:00.000Z", endAt: "2026-08-10T17:30:00.000Z",
      }],
    };
    configured.locations[0]!.policies.concurrentCapacity = 1;
    const full = await createService(locationAppointments, noCalendarConflicts, workingHours, configured).findAvailableSlots({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", employeeId: "dr-lee",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    });
    expect(full).toEqual({ ok: true, value: [] });

    configured.locations[0]!.policies.concurrentCapacity = 2;
    const available = await createService(locationAppointments, noCalendarConflicts, workingHours, configured).validateSlot({
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning",
      employeeId: "dr-lee", startAt: "2026-08-10T16:00:00.000Z",
    });
    expect(available.ok).toBe(true);
  });
});

describe("Checkpoint A availability suggestions", () => {
  const query = { tenantId: business.tenantId, locationId: "default", serviceId: "cleaning", rangeStart: "2026-08-10T16:00:00.000Z", rangeEnd: "2026-08-10T16:30:00.000Z" };
  const configured = (enabled = true, expansionDays = 1, maximumAlternatives = 3) => {
    const profile = upgradeBusinessProfile(business);
    profile.locations[0]!.policies.availabilitySuggestions = { enabled, expansionDays, maximumAlternatives };
    return profile;
  };
  it("leaves omitted and disabled policies with exact-range results", async () => {
    const previous = await createService().findAvailableSlots(query);
    expect(previous.ok && previous.value).toHaveLength(1);
    expect(await createService(noAppointments, noCalendarConflicts, workingHours, configured(false)).findAvailableSlots(query)).toEqual(previous);
  });
  it("keeps the preferred slot first and labels capped, verified alternatives", async () => {
    const result = await createService(noAppointments, noCalendarConflicts, workingHours, configured()).findAvailableSlots(query);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value).toHaveLength(4);
    expect(result.value[0]).toMatchObject({ startAt: query.rangeStart });
    expect(result.value[0]).not.toHaveProperty("outsideRequestedRange");
    expect(result.value.slice(1).every(s => s.outsideRequestedRange && s.startAt >= query.rangeEnd)).toBe(true);
    expect(new Set(result.value.map(s => `${s.employeeId}:${s.startAt}`)).size).toBe(4);
  });
  it("expands an empty requested range only as far as configured", async () => {
    const empty = { ...query, rangeStart: "2026-08-09T16:00:00.000Z", rangeEnd: "2026-08-09T17:00:00.000Z" };
    const result = await createService(noAppointments, noCalendarConflicts, workingHours, configured(true, 1, 2)).findAvailableSlots(empty);
    expect(result.ok && result.value).toHaveLength(2);
    if (result.ok) expect(result.value.every(s => s.outsideRequestedRange && s.endAt <= "2026-08-10T17:00:00.000Z")).toBe(true);
    const beforeClosedDays = { ...query, rangeStart: "2026-08-11T16:00:00Z", rangeEnd: "2026-08-11T17:00:00Z" };
    expect(await createService(noAppointments, noCalendarConflicts, workingHours, configured()).findAvailableSlots(beforeClosedDays)).toEqual({ ok: true, value: [] });
  });
  it("does not expand when enough preferred options exist or limit is zero", async () => {
    const service = createService(noAppointments, noCalendarConflicts, workingHours, configured(true, 1, 1));
    expect(await service.findAvailableSlots(query)).toEqual(await createService().findAvailableSlots(query));
    expect(await service.findAvailableSlots({ ...query, limit: 0 })).toEqual({ ok: true, value: [] });
  });
  it("never offers conflicting alternative times", async () => {
    const calendar: CalendarPort = { getBusyIntervals: async () => success([{ startAt: "2026-08-10T16:30:00Z", endAt: "2026-08-10T18:00:00Z" }]) };
    const result = await createService(noAppointments, calendar, workingHours, configured()).findAvailableSlots(query);
    expect(result.ok && result.value).toHaveLength(1);
  });
  it("preserves tenant isolation and booking horizon for expansion", async () => {
    const profile = configured(); profile.locations[0]!.policies.maximumBookingHorizonDays = 1;
    const service = createService(noAppointments, noCalendarConflicts, workingHours, profile);
    expect(await service.findAvailableSlots(query)).toEqual({ ok: true, value: [] });
    expect((await service.findAvailableSlots({ ...query, tenantId: "other-tenant" })).ok).toBe(false);
  });
  it("surfaces Calendar failures during expansion instead of inventing alternatives", async () => {
    let reads = 0;
    const calendar: CalendarPort = { getBusyIntervals: async () => ++reads === 1
      ? success([]) : failure({ code: "PROVIDER_UNAVAILABLE", retryable: true }) };
    const result = await createService(noAppointments, calendar, workingHours, configured()).findAvailableSlots(query);
    expect(result).toEqual({ ok: false, error: { code: "EXTERNAL_CALENDAR_UNAVAILABLE", retryable: true } });
  });
  it("does not offer or accept a disabled professional", async () => {
    const inactiveProfessional = upgradeBusinessProfile(structuredClone(business));
    inactiveProfessional.professionals[0]!.active = false;
    inactiveProfessional.locations[0]!.professionals[0]!.active = false;
    const inactiveAssignment = upgradeBusinessProfile(structuredClone(business));
    inactiveAssignment.locations[0]!.professionals[0]!.active = false;
    const query = {
      tenantId: business.tenantId, locationId: "default", serviceId: "cleaning",
      rangeStart: "2026-08-10T00:00:00.000Z", rangeEnd: "2026-08-11T00:00:00.000Z",
    };
    const slot = { ...query, employeeId: "dr-lee", startAt: "2026-08-10T16:30:00.000Z" };
    for (const profile of [inactiveProfessional, inactiveAssignment]) {
      const service = createService(noAppointments, noCalendarConflicts, workingHours, profile);
      expect(await service.findAvailableSlots(query)).toEqual({ ok: false, error: { code: "EMPLOYEE_UNAVAILABLE" } });
      expect(await service.validateSlot(slot)).toEqual({ ok: false, error: { code: "EMPLOYEE_NOT_FOUND" } });
    }
  });
  it("rejects malformed expansion settings before scheduling", () => {
    expect(() => createService(noAppointments, noCalendarConflicts, workingHours, configured(true, 100))).toThrow();
    expect(() => createService(noAppointments, noCalendarConflicts, workingHours, configured(true, 1, 0))).toThrow();
  });
});
