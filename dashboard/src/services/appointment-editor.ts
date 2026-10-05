import { reactive } from "vue";
import { api, ApiError, type Appointment, type AppointmentLocation, type Slot } from "./api.js";
import { availabilityRange } from "./availability-search.js";

export function appointmentTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
export function createAppointmentEditor(client = api) {
  const state = reactive({ locations: [] as AppointmentLocation[], locationId: "", customerId: "", appointmentId: "",
    appointments: [] as Appointment[], selected: undefined as Appointment | undefined, slots: [] as Slot[],
    pending: undefined as { kind: "cancel" | "reschedule"; startAt?: string } | undefined,
    busy: false, error: "", message: "", listed: false });
  async function run(operation: () => Promise<void>) {
    if (state.busy) return false;
    state.busy = true; state.error = ""; state.message = "";
    try { await operation(); return true; }
    catch (error) {
      state.error = appointmentErrorMessage(error);
      return false;
    } finally { state.busy = false; }
  }
  const load = () => run(async () => {
    state.locations = (await client.appointmentLocations()).locations;
    if (!state.locations.some(l => l.id === state.locationId)) state.locationId = state.locations[0]?.id ?? "";
  });
  function clear() {
    state.appointments = []; state.selected = undefined; state.slots = []; state.pending = undefined;
    state.error = ""; state.message = ""; state.listed = false;
  }
  const list = () => run(async () => {
    clear();
    if (!state.locationId || !state.customerId.trim()) throw new Error("Missing identifiers");
    state.appointments = (await client.customerAppointments(state.locationId, state.customerId.trim())).appointments;
    state.listed = true;
  });
  const lookup = (id = state.appointmentId) => run(async () => {
    state.selected = undefined; state.slots = []; state.pending = undefined;
    state.selected = await client.locationAppointment(state.locationId, id.trim());
  });
  const availability = (day: string) => run(async () => {
    state.slots = []; state.pending = undefined;
    const appointment = state.selected;
    const location = state.locations.find(l => l.id === appointment?.locationId);
    if (!appointment || !location) throw new Error("Missing date");
    const { rangeStart, rangeEnd } = availabilityRange(day, "", "", location.timezone);
    state.slots = (await client.availability({ locationId: appointment.locationId, serviceId: appointment.serviceId,
      employeeId: appointment.employeeId, rangeStart, rangeEnd })).slots;
  });
  const confirm = () => run(async () => {
    const appointment = state.selected; const pending = state.pending;
    if (!appointment || !pending || appointment.status !== "CONFIRMED") throw new Error("Missing action");
    // Consume the confirmation before sending; failures never trigger an automatic mutation retry.
    state.pending = undefined; state.slots = [];
    const updated = pending.kind === "cancel"
      ? await client.cancelAppointment(appointment.locationId, appointment.id, appointment.version ?? 1)
      : await client.rescheduleAppointment(appointment.locationId, appointment.id, pending.startAt!, appointment.version ?? 1);
    state.selected = updated;
    state.appointments = state.appointments.map(item => item.id === updated.id ? updated : item);
    state.message = pending.kind === "cancel" ? "Appointment cancelled." : "Appointment rescheduled.";
  });
  return { state, load, clear, list, lookup, availability, confirm };
}

export function appointmentErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "REQUEST_FAILED";
  const messages: Record<string, string> = {
    APPOINTMENT_VERSION_CONFLICT: "This appointment was changed by someone else. Refresh, review its current details and choose your action again.",
    APPOINTMENT_OPERATION_IN_PROGRESS: "Another appointment operation is in progress. Wait, then refresh and review before trying again.",
    CANCELLATION_NOTICE_NOT_MET: "Cancellation is inside the location’s minimum notice period.",
    RESCHEDULE_NOTICE_NOT_MET: "Rescheduling is inside the location’s minimum notice period.",
    SLOT_NO_LONGER_AVAILABLE: "That slot is no longer available. Check availability again.",
    CALENDAR_SYNC_FAILED: "Calendar operation could not be verified. Refresh and check with staff before retrying.",
    APPOINTMENT_NOT_FOUND: "Appointment not found at this location.",
    APPOINTMENT_NOT_CONFIRMED: "This appointment is no longer confirmed. Reload it before continuing.",
    APPOINTMENT_ALREADY_CANCELLED: "This appointment is already cancelled. Reload to see its status.",
  };
  return messages[code] ?? "The request did not complete. Check your access and inputs, then reload before retrying.";
}
