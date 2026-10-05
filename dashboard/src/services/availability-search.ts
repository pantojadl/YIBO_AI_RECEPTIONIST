import { computed, reactive, watch } from "vue";
import { api, ApiError, type AvailabilityLocation, type Slot } from "./api.js";
import { localParts } from "../../../src/modules/scheduling/domain/time.js";

type AvailabilityClient = Pick<typeof api, "appointmentLocations" | "availability" | "createAppointment">;
export interface AvailabilityPreferences { locationId?: string; serviceId?: string; employeeId?: string; day?: string }
export const slotKey = (slot: Slot): string => `${slot.employeeId}:${slot.startAt}:${slot.endAt}`;

function parseDay(day: string): Date {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== day) {
    throw new Error("Choose a valid date.");
  }
  return date;
}

function nextDay(day: string): string {
  const date = parseDay(day); date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function localInstant(day: string, time: string, timezone: string): string {
  parseDay(day);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose valid start and end times.");
  const target = Date.parse(`${day}T${time}:00Z`);
  let instant = target;
  const wallTime = (value: number) => {
    const local = localParts(new Date(value), timezone);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  };
  // Resolve wall time without consulting the browser's zone, including offset changes that day.
  for (let attempt = 0; attempt < 4; attempt++) {
    const rendered = wallTime(instant);
    if (rendered === target) {
      for (const nearby of [instant - 86_400_000, instant + 86_400_000]) {
        const candidate = target - (wallTime(nearby) - nearby);
        if (candidate !== instant && wallTime(candidate) === target) {
          throw new Error("That local time occurs twice because the clocks change. Search the whole day and choose a slot by its displayed time zone.");
        }
      }
      return new Date(instant).toISOString();
    }
    instant += target - rendered;
  }
  throw new Error("That local time does not exist because the clocks change. Choose another time.");
}

export function availabilityRange(day: string, startTime: string, endTime: string, timezone: string) {
  if (Boolean(startTime) !== Boolean(endTime)) throw new Error("Enter both times, or leave both empty to search the whole day.");
  if (startTime && startTime >= endTime) throw new Error("End time must be after start time on the selected day.");
  const rangeStart = localInstant(day, startTime || "00:00", timezone);
  const rangeEnd = localInstant(endTime ? day : nextDay(day), endTime || "00:00", timezone);
  return { rangeStart, rangeEnd };
}

export function availabilityTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}

function requestError(error: unknown, booking = false): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "SLOT_NO_LONGER_AVAILABLE" || code === "SLOT_CONFLICT") return "That time is no longer available. Search again and choose another option.";
  if (code === "CALENDAR_SYNC_FAILED" || (booking && !code)) return "Booking could not be verified. Check Appointments before trying again; no automatic retry was made.";
  if (["CALENDAR_NOT_CONNECTED", "CALENDAR_AUTHORIZATION_REQUIRED", "CALENDAR_RATE_LIMITED", "EXTERNAL_CALENDAR_UNAVAILABLE"].includes(code)) {
    return "Calendar availability could not be verified. Try again later or contact your administrator.";
  }
  return booking ? "The appointment was not confirmed. Check your access and the current booking rules before trying again."
    : "Availability could not be checked. Check your access and filters, then try again.";
}

export function createAvailabilitySearch(client: AvailabilityClient = api, now = () => new Date()) {
  const state = reactive({
    locations: [] as AvailabilityLocation[], loaded: false, loadingLocations: false, metadataError: "",
    filters: { locationId: "", serviceId: "", employeeId: "", day: "", startTime: "", endTime: "" },
    phase: "idle" as "idle" | "loading" | "results" | "error", error: "", booking: false,
    slots: [] as Slot[], selected: undefined as Slot | undefined,
  });
  const location = computed(() => state.locations.find(item => item.active && item.id === state.filters.locationId));
  const service = computed(() => location.value?.services.find(item => item.id === state.filters.serviceId));
  const professionals = computed(() => location.value?.professionals.filter(item => service.value?.eligibleEmployeeIds.includes(item.id)) ?? []);
  const requested = computed(() => state.slots.filter(slot => !slot.outsideRequestedRange));
  const alternatives = computed(() => state.slots.filter(slot => slot.outsideRequestedRange));
  let generation = 0;
  let disposed = false;
  function clear() {
    generation++; state.slots = []; state.selected = undefined; state.phase = "idle"; state.error = "";
  }
  const stopLocation = watch(() => state.filters.locationId, () => {
    state.filters.serviceId = location.value?.services[0]?.id ?? "";
    state.filters.employeeId = "";
  }, { flush: "sync" });
  const stopService = watch(() => state.filters.serviceId, () => { state.filters.employeeId = ""; }, { flush: "sync" });
  const stopFilters = watch(() => Object.values(state.filters), clear, { flush: "sync" });

  async function load(preferences?: AvailabilityPreferences) {
    if (state.loadingLocations || state.booking || disposed) return;
    clear(); state.loadingLocations = true; state.metadataError = "";
    try {
      const result = await client.appointmentLocations();
      if (disposed) return;
      state.locations = result.locations.filter(item => item.active);
      state.loaded = true;
      if (preferences?.locationId && state.locations.some(item => item.id === preferences.locationId)) {
        state.filters.locationId = preferences.locationId;
      }
      if (!location.value) state.filters.locationId = state.locations[0]?.id ?? "";
      if (preferences?.serviceId && location.value?.services.some(item => item.id === preferences.serviceId)) {
        state.filters.serviceId = preferences.serviceId;
      } else if (preferences?.employeeId && !preferences.serviceId) {
        state.filters.serviceId = location.value?.services.find(item => item.eligibleEmployeeIds.includes(preferences.employeeId!))?.id ?? "";
      }
      if (!service.value) state.filters.serviceId = location.value?.services[0]?.id ?? "";
      if (preferences?.employeeId && professionals.value.some(item => item.id === preferences.employeeId)) {
        state.filters.employeeId = preferences.employeeId;
      }
      if (!professionals.value.some(item => item.id === state.filters.employeeId)) state.filters.employeeId = "";
      if (preferences?.day) state.filters.day = preferences.day;
      if (!state.filters.day && location.value) {
        const local = localParts(now(), location.value.timezone);
        state.filters.day = nextDay(`${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`);
      }
    } catch { if (!disposed) state.metadataError = "Unable to load availability choices. Check your access and retry."; }
    finally { if (!disposed) state.loadingLocations = false; }
  }

  async function search() {
    if (state.booking || state.loadingLocations || disposed) return false;
    clear();
    const requestGeneration = generation;
    const selectedLocation = location.value;
    const selectedService = service.value;
    let range: ReturnType<typeof availabilityRange>;
    try {
      if (!selectedLocation || !selectedService || !professionals.value.length) throw new Error("Choose a location and a service with an available professional.");
      if (state.filters.employeeId && !professionals.value.some(item => item.id === state.filters.employeeId)) throw new Error("Choose a professional who offers this service at this location.");
      range = availabilityRange(state.filters.day, state.filters.startTime, state.filters.endTime, selectedLocation.timezone);
    } catch (error) {
      state.phase = "error"; state.error = error instanceof Error ? error.message : "Check your search filters."; return false;
    }
    state.phase = "loading";
    try {
      const result = await client.availability({ locationId: selectedLocation.id, serviceId: selectedService.id,
        ...(state.filters.employeeId ? { employeeId: state.filters.employeeId } : {}), ...range });
      if (disposed || requestGeneration !== generation) return false;
      state.slots = result.slots; state.phase = "results";
      return true;
    } catch (error) {
      if (!disposed && requestGeneration === generation) { state.phase = "error"; state.error = requestError(error); }
      return false;
    }
  }

  function select(slot: Slot) {
    if (state.phase === "results" && !state.booking) state.selected = state.slots.find(item => slotKey(item) === slotKey(slot));
  }

  async function book(customerId: string) {
    const selected = state.selected;
    if (disposed || state.booking || !customerId.trim() || !location.value || !service.value || !selected
      || !state.slots.some(slot => slotKey(slot) === slotKey(selected))) return;
    const input = { locationId: location.value.id, customerId, serviceId: service.value.id,
      employeeId: selected.employeeId, startAt: selected.startAt, idempotencyKey: crypto.randomUUID() };
    // Consume the selection before awaiting: duplicate clicks and failed requests never retry a booking.
    state.booking = true; clear();
    try {
      const appointment = await client.createAppointment(input);
      if (disposed) return;
      if (appointment.status !== "CONFIRMED") throw new Error("Booking not confirmed");
      return appointment;
    } catch (error) { if (!disposed) state.error = requestError(error, true); }
    finally { if (!disposed) state.booking = false; }
  }
  function dispose() { disposed = true; generation++; stopLocation(); stopService(); stopFilters(); }
  return { state, location, service, professionals, requested, alternatives, load, search, select, book, dispose };
}
