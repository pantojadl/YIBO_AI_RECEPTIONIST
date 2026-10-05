import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppointmentCalendar, calendarDay, calendarDays, calendarRange, shiftCalendarDay } from "../../dashboard/src/services/appointment-calendar.js";
import { createBookingCustomer } from "../../dashboard/src/services/booking-customer.js";
import { createAvailabilitySearch } from "../../dashboard/src/services/availability-search.js";
import { ApiError, type AppointmentCalendarEntry, type AvailabilityLocation } from "../../dashboard/src/services/api.js";

const locations: AvailabilityLocation[] = [
  { id: "east", name: "East", active: true, timezone: "America/New_York", minimumCancellationNoticeMinutes: 60, minimumRescheduleNoticeMinutes: 60,
    services: [{ id: "consultation", name: "Consultation", durationMinutes: 30, bufferMinutes: 0, eligibleEmployeeIds: ["alex"] }],
    professionals: [{ id: "alex", displayName: "Alex Example", name: "Alex Example", serviceIds: ["consultation"] }],
    availabilitySuggestions: { enabled: false, expansionDays: 1, maximumAlternatives: 3 } },
  { id: "west", name: "West", active: false, timezone: "America/Los_Angeles", minimumCancellationNoticeMinutes: 0, minimumRescheduleNoticeMinutes: 0,
    services: [], professionals: [], availabilitySuggestions: { enabled: false, expansionDays: 1, maximumAlternatives: 3 } },
];
const entry = (changes: Partial<AppointmentCalendarEntry> = {}): AppointmentCalendarEntry => ({
  id: "one", customerId: "customer", customerName: "Taylor Example", customerPhone: "+15550000001",
  locationId: "east", employeeId: "alex", professionalName: "Alex Example", serviceId: "consultation", serviceNameSnapshot: "Consultation",
  priceAmountMinor: 12550, priceCurrency: "USD", startAt: "2026-09-22T14:00:00.000Z", endAt: "2026-09-22T14:30:00.000Z", status: "CONFIRMED",
  ...changes,
});
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); });
function fixture(appointments = [entry()]) {
  const client = {
    appointmentLocations: vi.fn(async () => ({ locations })),
    appointmentCalendar: vi.fn(async () => ({ appointments })),
  };
  const calendar = createAppointmentCalendar(client, () => new Date("2026-09-22T00:30:00Z"));
  disposers.push(calendar.dispose);
  return { calendar, client };
}

describe("office calendar periods and state", () => {
  it.each([
    ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("uses the full location-local day across DST: %s", (day, rangeStart, rangeEnd) => {
    expect(calendarRange(day!, "day", "America/New_York")).toEqual({ rangeStart, rangeEnd });
  });
  it("uses Monday–Sunday for week and agenda, including year boundaries", () => {
    expect(calendarDays("2027-01-01", "week")).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
    expect(calendarDays("2027-01-01", "agenda")).toEqual(calendarDays("2027-01-01", "week"));
    expect(shiftCalendarDay("2026-12-31", 1)).toBe("2027-01-01");
  });
  it.each(["", "2026-02-30", "2026-13-01"])("rejects invalid calendar dates: %s", day => {
    expect(() => calendarRange(day, "day", "America/New_York")).toThrow("valid calendar date");
  });
  it("starts on today's date in the location's timezone and navigates by view", async () => {
    const { calendar, client } = fixture(); await calendar.load();
    expect(calendar.state.day).toBe("2026-09-21");
    expect(calendarDay("2026-09-22T00:30:00Z", "America/Los_Angeles")).toBe("2026-09-21");
    await calendar.move(1); expect(calendar.state.day).toBe("2026-09-28");
    calendar.state.view = "day"; await calendar.move(-1); expect(calendar.state.day).toBe("2026-09-27");
    await calendar.today(); expect(client.appointmentCalendar).toHaveBeenLastCalledWith("east", {
      rangeStart: "2026-09-21T04:00:00.000Z", rangeEnd: "2026-09-22T04:00:00.000Z",
    });
  });
  it("shows all staff, includes uncertain bookings, and keeps cancelled/inactive staff filterable", async () => {
    const { calendar } = fixture([entry(), entry({ id: "cancelled", status: "CANCELLED", employeeId: "old", professionalName: "Former Provider" }),
      entry({ id: "pending", status: "PENDING_CONFIRMATION" }), entry({ id: "failed", status: "FAILED" })]);
    await calendar.load();
    expect(calendar.visible.value.map(item => item.id)).toEqual(["one", "pending", "failed"]);
    expect(calendar.professionals.value).toContainEqual({ id: "old", displayName: "Former Provider" });
    calendar.state.showCancelled = true; calendar.state.employeeId = "old";
    expect(calendar.visible.value.map(item => item.id)).toEqual(["cancelled"]);
    calendar.state.locationId = "west";
    expect(calendar.state.employeeId).toBe(""); expect(calendar.state.appointments).toEqual([]);
    expect(calendar.location.value?.active).toBe(false);
  });
  it("shows overnight appointments on each overlapping day without adding a midnight-ending extra day", async () => {
    const { calendar } = fixture([entry({ startAt: "2026-09-22T03:30:00.000Z", endAt: "2026-09-22T04:30:00.000Z" }),
      entry({ id: "ends-midnight", startAt: "2026-09-22T03:00:00.000Z", endAt: "2026-09-22T04:00:00.000Z" })]);
    await calendar.load();
    expect(calendar.groups.value.find(group => group.day === "2026-09-21")?.appointments).toHaveLength(2);
    expect(calendar.groups.value.find(group => group.day === "2026-09-22")?.appointments.map(item => item.id)).toEqual(["one"]);
  });
  it("ignores late success from another date/location", async () => {
    const { calendar, client } = fixture(); await calendar.load();
    let resolve!: (value: { appointments: AppointmentCalendarEntry[] }) => void;
    client.appointmentCalendar.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const previous = calendar.refresh();
    calendar.state.locationId = "west"; calendar.state.day = "2026-10-01";
    client.appointmentCalendar.mockResolvedValueOnce({ appointments: [] });
    await calendar.refresh(); resolve({ appointments: [entry()] }); await previous;
    expect(calendar.state.appointments).toEqual([]); expect(calendar.state.loaded).toBe(true);
  });
  it("ignores late failures and clears stale appointments while a refresh fails", async () => {
    const { calendar, client } = fixture(); await calendar.load();
    let reject!: (error: Error) => void;
    client.appointmentCalendar.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    const previous = calendar.refresh(); calendar.state.day = "2026-10-01"; await calendar.refresh();
    reject(new Error("old failure")); await previous; expect(calendar.state.error).toBe("");
    client.appointmentCalendar.mockRejectedValueOnce(new Error("offline"));
    expect(await calendar.refresh()).toBe(false); expect(calendar.state.appointments).toEqual([]);
    expect(calendar.state.loaded).toBe(false); expect(calendar.state.error).toContain("could not be loaded");
    expect(await calendar.refresh()).toBe(true); expect(calendar.state.error).toBe("");
  });
  it("does not populate an unmounted calendar", async () => {
    const { calendar, client } = fixture(); await calendar.load();
    let resolve!: (value: { appointments: AppointmentCalendarEntry[] }) => void;
    client.appointmentCalendar.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = calendar.refresh(); calendar.dispose(); resolve({ appointments: [entry()] }); await pending;
    expect(calendar.state.appointments).toEqual([]);
  });
});

describe("manual appointment customer and availability handoff", () => {
  it("selects the returned existing customer without overwriting their name or normalized phone", async () => {
    const existing = { id: "existing", tenantId: "tenant", name: "Taylor Example", phone: "+15550000001" };
    const client = vi.fn(async () => existing), customer = createBookingCustomer(undefined, client);
    customer.state.name = "Another draft name"; customer.state.phone = " +1 (555) 000-0001 ";
    expect(await customer.choose()).toEqual(existing); expect(customer.state.selected).toEqual(existing);
    expect(client).toHaveBeenCalledWith({ phone: "+1 (555) 000-0001", name: "Another draft name" });
    customer.clear(); expect(customer.state.selected).toBeUndefined(); expect(customer.state.phone).toBe("");
  });
  it("does not choose a customer on failure or send a duplicate lookup on double click", async () => {
    const client = vi.fn(async () => { throw new ApiError("VALIDATION_ERROR", 400); });
    const customer = createBookingCustomer(undefined, client); customer.state.phone = "bad";
    await Promise.all([customer.choose(), customer.choose()]);
    expect(client).toHaveBeenCalledTimes(1); expect(customer.state.selected).toBeUndefined();
    expect(customer.state.error).toContain("Check the phone"); expect(customer.state.busy).toBe(false);
  });
  it("opens availability on the selected location, date and eligible professional without preselecting a time", async () => {
    const client = { appointmentLocations: async () => ({ locations }), availability: vi.fn(async () => ({ slots: [] })), createAppointment: vi.fn() };
    const search = createAvailabilitySearch(client); disposers.push(search.dispose);
    await search.load({ locationId: "east", day: "2026-10-05", employeeId: "alex" }); await search.search();
    expect(client.availability).toHaveBeenCalledWith({ locationId: "east", serviceId: "consultation", employeeId: "alex",
      rangeStart: "2026-10-05T04:00:00.000Z", rangeEnd: "2026-10-06T04:00:00.000Z" });
    expect(search.state.selected).toBeUndefined(); expect(client.createAppointment).not.toHaveBeenCalled();
  });
  it("chooses a service offered by the selected staff member when opening available times", async () => {
    const staffLocation = structuredClone(locations[0]!);
    staffLocation.professionals.push({ id: "specialist", displayName: "Specialist", name: "Specialist", serviceIds: ["consultation"] });
    staffLocation.services.push({ id: "cleaning", name: "Cleaning", durationMinutes: 45, bufferMinutes: 0, eligibleEmployeeIds: ["specialist"] });
    const client = { appointmentLocations: async () => ({ locations: [staffLocation] }), availability: vi.fn(async () => ({ slots: [] })), createAppointment: vi.fn() };
    const search = createAvailabilitySearch(client); disposers.push(search.dispose);
    await search.load({ locationId: "east", day: "2026-10-05", employeeId: "specialist" });
    expect(search.state.filters).toMatchObject({ serviceId: "cleaning", employeeId: "specialist" });
  });
});
