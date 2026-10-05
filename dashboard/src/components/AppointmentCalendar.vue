<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AppointmentAdministration from "./AppointmentAdministration.vue";
import ManualAppointmentBooking from "./ManualAppointmentBooking.vue";
import type { Appointment, AppointmentCalendarEntry, Customer } from "../services/api";
import { createAppointmentCalendar, calendarDay, calendarDateLabel, appointmentStatusLabel, type CalendarView } from "../services/appointment-calendar";
import { availabilityTime, type AvailabilityPreferences } from "../services/availability-search";
import { useUnsavedChanges } from "../services/unsaved-changes";

const props = defineProps<{ customer?: Customer; initialAppointment?: Appointment; readOnly?: boolean }>();
const emit = defineEmits<{ customerSelected: [customer: Customer] }>();
const calendar = createAppointmentCalendar(), { state, location, groups, professionals } = calendar;
const dialog = ref<HTMLDialogElement>(), mode = ref<"book" | "details">();
const selected = ref<AppointmentCalendarEntry>(), preferences = ref<AvailabilityPreferences>({});
const modalBusy = ref(false), message = ref("");
watch(() => [state.locationId, state.day, state.view, state.employeeId, state.showCancelled], () => { message.value = ""; }, { flush: "sync" });
const views: CalendarView[] = ["day", "week", "agenda"];
useUnsavedChanges(() => false, () => modalBusy.value);
const period = computed(() => {
  const days = calendar.days.value;
  if (days.length && days[0]!.slice(0, 4) !== days.at(-1)!.slice(0, 4)) {
    return `${calendarDateLabel(days[0]!)}, ${days[0]!.slice(0, 4)} – ${calendarDateLabel(days.at(-1)!)}, ${days.at(-1)!.slice(0, 4)}`;
  }
  return days.length ? `${calendarDateLabel(days[0]!)}${days.length > 1 ? ` – ${calendarDateLabel(days.at(-1)!)}` : ""}, ${days[0]!.slice(0, 4)}` : "Choose a date";
});
const time = (instant: string) => availabilityTime(instant, location.value?.timezone ?? "UTC");
const shortTime = (instant: string) => new Intl.DateTimeFormat("en-US", {
  timeZone: location.value?.timezone ?? "UTC", hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(instant));
const staffColor = (id: string) => ["#2758b8", "#7e438f", "#20705d", "#9a5515", "#93414d", "#416978"][
  [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
];
async function showDialog() { await nextTick(); dialog.value?.showModal(); }
async function book(day = state.day) {
  if (props.readOnly || !location.value?.active) return;
  preferences.value = { locationId: state.locationId, day, ...(state.employeeId ? { employeeId: state.employeeId } : {}) };
  mode.value = "book"; await showDialog();
}
async function details(entry: AppointmentCalendarEntry) {
  selected.value = entry; mode.value = "details"; await showDialog();
}
function close() { if (!modalBusy.value) dialog.value?.close(); }
function closed() { mode.value = undefined; selected.value = undefined; modalBusy.value = false; }
async function booked(appointment: Appointment) {
  close();
  state.locationId = appointment.locationId; state.employeeId = "";
  state.day = calendarDay(appointment.startAt, location.value?.timezone ?? "UTC");
  message.value = `Appointment confirmed for ${time(appointment.startAt)}.`;
  await calendar.refresh();
}
async function changed(appointment: Appointment) {
  if (selected.value) selected.value = { ...selected.value, ...appointment };
  state.day = calendarDay(appointment.startAt, location.value?.timezone ?? "UTC");
  message.value = appointment.status === "CANCELLED" ? "Appointment cancelled."
    : `Appointment rescheduled to ${time(appointment.startAt)}.`;
  await calendar.refresh();
}
async function openDay(day: string) { state.day = day; state.view = "day"; await calendar.refresh(); }
onMounted(async () => {
  if (props.initialAppointment) state.locationId = props.initialAppointment.locationId;
  await calendar.load();
  if (props.initialAppointment && location.value) {
    state.day = calendarDay(props.initialAppointment.startAt, location.value.timezone);
    await calendar.refresh();
    const entry = state.appointments.find(item => item.id === props.initialAppointment?.id);
    if (entry) await details(entry);
  }
});
onBeforeUnmount(() => { dialog.value?.close(); calendar.dispose(); });
</script>

<template>
  <section class="appointment-calendar" aria-labelledby="calendar-title">
    <div class="section-heading">
      <div><p class="eyebrow">Front desk</p><h2 id="calendar-title">Appointments</h2><p>Your team’s appointments, with available times one click away.</p></div>
      <button v-if="!readOnly" class="primary" :disabled="!location?.active || state.loadingLocations" @click="book()">New appointment</button>
    </div>
    <p v-if="message" class="calendar-success" role="status">{{ message }}</p>
    <p v-if="state.metadataError" role="alert">{{ state.metadataError }} <button @click="calendar.load()">Try again</button></p>
    <p v-if="state.loadingLocations" role="status">Loading calendar choices…</p>
    <p v-else-if="!state.metadataError && !state.locations.length">No locations have been configured. Contact your administrator.</p>
    <template v-if="state.locations.length">
      <div class="calendar-toolbar">
        <label>Calendar location<select v-model="state.locationId" :disabled="state.loadingLocations" @change="calendar.refresh()"><option v-for="item in state.locations" :key="item.id" :value="item.id">{{ item.name }}{{ item.active ? '' : ' (inactive)' }}</option></select></label>
        <label>Staff member<select v-model="state.employeeId"><option value="">All staff</option><option v-for="person in professionals" :key="person.id" :value="person.id">{{ person.displayName }}</option></select></label>
        <label>Calendar date<input v-model="state.day" type="date" @change="calendar.refresh()"></label>
        <label class="cancelled-toggle"><input v-model="state.showCancelled" type="checkbox">Show cancelled</label>
      </div>
      <div class="calendar-navigation">
        <div class="date-navigation"><button aria-label="Previous period" @click="calendar.move(-1)">←</button><button @click="calendar.today()">Today</button><button aria-label="Next period" @click="calendar.move(1)">→</button></div>
        <h3>{{ period }}</h3>
        <div class="view-switch" role="group" aria-label="Calendar view"><button v-for="view in views" :key="view" :aria-pressed="state.view === view" @click="state.view = view; calendar.refresh()">{{ view[0]!.toUpperCase() + view.slice(1) }}</button></div>
        <button :disabled="state.loading" @click="calendar.refresh()">Refresh</button>
      </div>
      <div class="calendar-summary"><p>Times in <strong>{{ location?.timezone }}</strong> · {{ location?.name }}</p><p v-if="state.loaded">{{ calendar.visible.value.length }} {{ calendar.visible.value.length === 1 ? 'appointment' : 'appointments' }}{{ state.employeeId ? ' for this staff member' : '' }}</p></div>
      <p v-if="location && !location.active">This location is inactive. Existing appointments are still visible; new bookings are unavailable.</p>
      <p v-if="state.error" role="alert">{{ state.error }} <button @click="calendar.refresh()">Try again</button></p>
      <p v-if="state.loading" role="status">Loading appointments…</p>
      <div v-if="state.loaded" class="calendar-days" :class="state.view">
        <section v-for="group in groups" :key="group.day" class="calendar-day" :aria-label="calendarDateLabel(group.day)">
          <div class="day-heading"><button :aria-label="`Open ${calendarDateLabel(group.day)}`" @click="openDay(group.day)">{{ calendarDateLabel(group.day) }}</button><span>{{ group.appointments.length }}</span></div>
          <ol v-if="group.appointments.length" class="appointment-list">
            <li v-for="entry in group.appointments" :key="entry.id">
              <button class="appointment-card" :class="{ cancelled: entry.status === 'CANCELLED', attention: ['FAILED', 'PENDING_CONFIRMATION'].includes(entry.status) }" :style="{ '--staff-color': staffColor(entry.employeeId) }" @click="details(entry)">
                <span class="appointment-clock">{{ shortTime(entry.startAt) }} – {{ shortTime(entry.endAt) }}</span>
                <span v-if="calendarDay(entry.startAt, location?.timezone ?? 'UTC') !== group.day || calendarDay(entry.endAt, location?.timezone ?? 'UTC') !== group.day" class="spans-days">{{ time(entry.startAt) }} – {{ time(entry.endAt) }}</span>
                <strong>{{ entry.customerName || entry.customerPhone || 'Customer unavailable' }}</strong>
                <span>{{ entry.serviceNameSnapshot }}</span>
                <span class="staff-name"><span class="staff-dot" aria-hidden="true"></span>{{ entry.professionalName }}</span>
                <span class="appointment-status">{{ appointmentStatusLabel(entry.outcomeStatus ?? entry.status) }}</span>
              </button>
            </li>
          </ol>
          <p v-else class="day-empty">No appointments{{ state.employeeId ? ' for this staff member' : '' }}.</p>
          <button v-if="location?.active && !readOnly" class="find-times" :aria-label="`Find available times on ${calendarDateLabel(group.day)}`" @click="book(group.day)">+ Find available times</button>
        </section>
      </div>
      <p class="calendar-note">Available times depend on the service and professional. Choose “Find available times” on a day to check them. Other events in your connected calendar also block availability; only YIBO appointments appear here.</p>
    </template>
    <dialog ref="dialog" class="appointment-dialog" aria-labelledby="appointment-dialog-title" @cancel.prevent="close" @close="closed">
      <div v-if="mode" class="dialog-content">
        <div class="dialog-heading"><h2 id="appointment-dialog-title">{{ mode === 'book' ? 'New appointment' : 'Appointment details' }}</h2><button :disabled="modalBusy" @click="close">Close</button></div>
        <ManualAppointmentBooking v-if="mode === 'book'" :customer="customer" :preferences="preferences" @busy="modalBusy = $event" @booked="booked" @customer-selected="emit('customerSelected', $event)" />
        <AppointmentAdministration v-else-if="selected" :key="selected.id" :entry="selected" :read-only="readOnly" embedded @busy="modalBusy = $event" @changed="changed" />
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.appointment-calendar{max-width:1380px;margin:auto}.appointment-calendar p{line-height:1.5}.appointment-calendar button:not(.primary){border:1px solid var(--line);border-radius:8px;padding:10px 13px;background:white;color:var(--blue-ink);font-weight:600}.appointment-calendar button:focus-visible{outline:3px solid var(--blue);outline-offset:3px}.appointment-calendar button:disabled{opacity:.5;cursor:not-allowed}.calendar-toolbar{display:grid;grid-template-columns:1.3fr 1fr 1fr auto;align-items:end;gap:16px;border:1px solid var(--line);padding:20px;background:#edf5ff;border-radius:14px}.cancelled-toggle{display:flex;align-items:center;gap:8px;min-height:42px}.cancelled-toggle input{width:18px;height:18px;flex:none}.calendar-navigation{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin:24px 0 10px}.calendar-navigation h3{margin:0 auto 0 0}.date-navigation,.view-switch{display:flex;gap:4px}.view-switch button[aria-pressed=true]{background:var(--blue);color:white;border-color:var(--blue)}.calendar-summary{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px}.calendar-summary p{margin:0 0 14px}.calendar-days{display:grid;gap:10px;align-items:start}.calendar-days.week{grid-template-columns:repeat(7,minmax(0,1fr))}.calendar-day{min-width:0;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px}.day-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:12px}.day-heading button{border:0!important;padding:4px!important;text-align:left}.day-heading>span{font-size:12px;color:var(--muted)}.appointment-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}.appointment-card{width:100%;display:grid;gap:7px;text-align:left;font-size:13px;line-height:1.4;overflow-wrap:anywhere;border-left:4px solid var(--staff-color)!important;background:#f5f8fe!important;padding:12px!important}.appointment-card:hover{background:#e6efff!important}.appointment-card strong{font-size:16px}.appointment-card .appointment-clock{font-size:12px;font-weight:750}.staff-name{display:flex;align-items:center;gap:6px;font-weight:600}.staff-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--staff-color);flex:none}.appointment-status{font-size:11px;width:fit-content;padding:3px 7px;border-radius:5px;color:#1a6343;background:#e0f1e8}.cancelled .appointment-status{background:#e8ebf1;color:#4f5970}.attention .appointment-status{background:#fff0cc;color:#795013}.spans-days{font-size:11px}.day-empty{font-size:13px;color:var(--muted);padding:14px 2px}.find-times{margin-top:14px;width:100%;text-align:left;color:#215743!important;border-style:dashed!important;font-size:12px}.calendar-days.day .appointment-card,.calendar-days.agenda .appointment-card{grid-template-columns:1fr 1.1fr 1fr 1fr auto;align-items:center;gap:16px}.calendar-days.day .spans-days,.calendar-days.agenda .spans-days{grid-column:1/-1}.calendar-note{font-size:13px;color:#536786;margin-top:20px;max-width:850px}.calendar-success{color:#165337;background:#e0f1e8;padding:14px;border-radius:10px}.appointment-calendar [role=alert]{color:#7b2424;background:#fff0ef;padding:14px;border-radius:10px}.appointment-dialog{width:min(1050px,calc(100% - 32px));max-height:calc(100dvh - 32px);border:1px solid var(--line);border-radius:18px;padding:0;color:var(--text);background:#fff;box-shadow:0 18px 70px #132b5840}.appointment-dialog::backdrop{background:#14254780}.dialog-content{padding:26px}.dialog-heading{display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:22px}.dialog-heading h2{font-size:30px;line-height:1.15}.dialog-heading button{flex:none}.appointment-dialog :deep(button){max-width:100%}@media(max-width:1100px){.calendar-days.week{grid-template-columns:repeat(3,minmax(0,1fr))}.calendar-toolbar{grid-template-columns:1fr 1fr}}@media(max-width:700px){.calendar-toolbar{grid-template-columns:1fr;padding:16px}.calendar-navigation h3{order:-1;flex-basis:100%;font-size:21px}.calendar-navigation{gap:12px}.calendar-days.week{grid-template-columns:1fr}.calendar-days.day .appointment-card,.calendar-days.agenda .appointment-card{grid-template-columns:1fr;gap:7px}.calendar-days.day .spans-days,.calendar-days.agenda .spans-days{grid-column:auto}.appointment-dialog{width:calc(100% - 16px);max-height:calc(100dvh - 16px);border-radius:12px}.dialog-content{padding:16px}.dialog-heading{gap:10px}.dialog-heading h2{font-size:26px}.calendar-success{overflow-wrap:anywhere}}
</style>
