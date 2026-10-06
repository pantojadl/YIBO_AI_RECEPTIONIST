import { computed, reactive, watch } from "vue";
import { api, type AppointmentCalendarEntry, type AvailabilityLocation } from "./api.js";
import { availabilityRange } from "./availability-search.js";
import { localParts } from "../../../src/modules/scheduling/domain/time.js";

export type CalendarView = "day" | "week" | "agenda";
type CalendarClient = Pick<typeof api, "appointmentLocations" | "appointmentCalendar">;

export function calendarDay(instant: string | Date, timezone: string): string {
  const local = localParts(new Date(instant), timezone);
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}
export function shiftCalendarDay(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== day) {
    throw new Error("Choose a valid calendar date.");
  }
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function calendarDays(day: string, view: CalendarView): string[] {
  shiftCalendarDay(day, 0);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const first = view === "day" ? day : shiftCalendarDay(day, -((weekday + 6) % 7));
  return Array.from({ length: view === "day" ? 1 : 7 }, (_, i) => shiftCalendarDay(first, i));
}
export function calendarRange(day: string, view: CalendarView, timezone: string) {
  const days = calendarDays(day, view);
  return {
    rangeStart: availabilityRange(days[0]!, "", "", timezone).rangeStart,
    rangeEnd: availabilityRange(days.at(-1)!, "", "", timezone).rangeEnd,
  };
}
export const calendarDateLabel = (day: string): string => new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
}).format(new Date(`${day}T12:00:00Z`));
export const appointmentStatusLabel = (status: string): string => ({
  CONFIRMED: "Confirmed", CANCELLED: "Cancelled", PENDING_CONFIRMATION: "Awaiting confirmation", FAILED: "Needs review",
}[status] ?? "Needs review");

export function createAppointmentCalendar(client: CalendarClient = api, now = () => new Date()) {
  const state = reactive({
    locations: [] as AvailabilityLocation[], locationId: "", day: "", view: "week" as CalendarView,
    employeeId: "", showCancelled: false, appointments: [] as AppointmentCalendarEntry[],
    loadingLocations: false, loading: false, loaded: false, error: "", metadataError: "",
  });
  const location = computed(() => state.locations.find(item => item.id === state.locationId));
  const days = computed(() => { try { return calendarDays(state.day, state.view); } catch { return []; } });
  const professionals = computed(() => {
    const choices = new Map(location.value?.professionals.map(item => [item.id, item.displayName]) ?? []);
    // Keep historical/inactive staff filterable when they own an appointment in this period.
    for (const entry of state.appointments) choices.set(entry.employeeId, entry.professionalName);
    return [...choices].map(([id, displayName]) => ({ id, displayName }));
  });
  const visible = computed(() => state.appointments.filter(item =>
    (!state.employeeId || item.employeeId === state.employeeId) && (state.showCancelled || item.status !== "CANCELLED")));
  const groups = computed(() => days.value.map(day => {
    const range = availabilityRange(day, "", "", location.value?.timezone ?? "UTC");
    return { day, appointments: visible.value.filter(item => item.startAt < range.rangeEnd && item.endAt > range.rangeStart) };
  }));
  let generation = 0, disposed = false;
  const clear = () => { generation++; state.appointments = []; state.loaded = false; state.loading = false; state.error = ""; };
  const stopLocation = watch(() => state.locationId, () => { state.employeeId = ""; }, { flush: "sync" });
  const stopRange = watch(() => [state.locationId, state.day, state.view], clear, { flush: "sync" });

  async function refresh() {
    if (disposed || !location.value) return false;
    const request = ++generation;
    state.loading = true; state.loaded = false; state.error = ""; state.appointments = [];
    try {
      const range = calendarRange(state.day, state.view, location.value.timezone);
      const result = await client.appointmentCalendar(state.locationId, range);
      if (disposed || request !== generation) return false;
      state.appointments = result.appointments; state.loaded = true;
      return true;
    } catch {
      if (!disposed && request === generation) state.error = "Appointments could not be loaded. Check the date and your access, then refresh.";
      return false;
    } finally { if (!disposed && request === generation) state.loading = false; }
  }
  async function load() {
    if (disposed || state.loadingLocations) return;
    state.loadingLocations = true; state.metadataError = "";
    try {
      const result = await client.appointmentLocations();
      if (disposed) return;
      state.locations = result.locations;
      if (!location.value) state.locationId = state.locations.find(item => item.active)?.id ?? state.locations[0]?.id ?? "";
      if (!state.day) state.day = calendarDay(now(), location.value?.timezone ?? "UTC");
      await refresh();
    } catch {
      if (!disposed) state.metadataError = "Locations could not be loaded. Check your access and try again.";
    } finally { if (!disposed) state.loadingLocations = false; }
  }
  async function move(amount: number) {
    try { state.day = shiftCalendarDay(state.day, amount * (state.view === "day" ? 1 : 7)); await refresh(); }
    catch { state.error = "Choose a valid calendar date."; }
  }
  async function today() { state.day = calendarDay(now(), location.value?.timezone ?? "UTC"); await refresh(); }
  function dispose() { disposed = true; clear(); stopLocation(); stopRange(); }
  return { state, location, days, groups, professionals, visible, load, refresh, move, today, dispose };
}
