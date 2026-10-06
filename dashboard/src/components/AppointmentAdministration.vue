<script setup lang="ts">
import { useUnsavedChanges } from "../services/unsaved-changes";
import { computed, onMounted, ref, watch } from "vue";
import { createAppointmentEditor } from "../services/appointment-editor";
import { availabilityTime } from "../services/availability-search";
import { calendarDay, appointmentStatusLabel } from "../services/appointment-calendar";
import type { Appointment, AppointmentCalendarEntry } from "../services/api";
import { priceText } from "../services/catalog-editor";
const props = defineProps<{ initialCustomerId?: string; initialAppointmentId?: string; initialLocationId?: string; entry?: AppointmentCalendarEntry; embedded?: boolean; readOnly?: boolean }>();
const emit = defineEmits<{ changed: [appointment: Appointment]; busy: [value: boolean] }>();
const editor = createAppointmentEditor(); const { state } = editor;
useUnsavedChanges(() => Boolean(state.pending), () => state.busy);
const day = ref(""), searched = ref(false);
const location = computed(() => state.locations.find(item => item.id === state.locationId));
const time = (value: string) => availabilityTime(value, location.value?.timezone ?? "UTC");
const notice = (minutes = 0) => minutes === 0 ? "No minimum notice" : minutes % 60 === 0 ? `${minutes / 60} hours before the appointment` : `${minutes} minutes before the appointment`;
watch(() => state.busy, value => emit("busy", value), { flush: "sync" });
async function findSlots() { searched.value = await editor.availability(day.value); }
async function confirm() { if (props.readOnly) return; if (await editor.confirm() && state.selected) { searched.value = false; emit("changed", state.selected); } }
onMounted(async () => {
  state.customerId = props.initialCustomerId ?? ""; state.appointmentId = props.entry?.id ?? props.initialAppointmentId ?? "";
  state.locationId = props.entry?.locationId ?? props.initialLocationId ?? "";
  if (await editor.load() && state.appointmentId && await editor.lookup()) {
    day.value = calendarDay(state.selected!.startAt, location.value?.timezone ?? "UTC");
    if (!props.embedded && state.selected?.status === "CONFIRMED")
    state.message = "Appointment confirmed. The details below use its location's time zone.";
  }
});
</script>
<template>
  <section class="appointment-admin">
    <template v-if="!embedded"><h2>Appointment administration</h2>
    <p>Look up an appointment or list a customer’s upcoming confirmed appointments at a location.</p></template>
    <p v-if="state.error" role="alert">{{ state.error }}</p><p v-if="state.message" role="status">{{ state.message }}</p>
    <button v-if="!embedded && !state.locations.length" :disabled="state.busy" @click="editor.load()">Load locations</button>
    <button v-if="embedded && (!state.selected || state.error)" :disabled="state.busy" @click="editor.load().then(ok => ok && editor.lookup())">Reload appointment details</button>
    <fieldset v-if="!embedded" :disabled="state.busy">
      <legend>Find appointments</legend>
      <label>Location<select v-model="state.locationId" @change="editor.clear()"><option v-for="item in state.locations" :key="item.id" :value="item.id">{{ item.name }}{{ item.active ? '' : ' (inactive)' }}</option></select></label>
      <form @submit.prevent="editor.list()"><label>Customer ID<input v-model="state.customerId" required></label><button :disabled="!state.locationId">List customer appointments</button></form>
      <form @submit.prevent="editor.lookup()"><label>Appointment ID<input v-model="state.appointmentId" required></label><button :disabled="!state.locationId">Find appointment</button></form>
      <p v-if="state.listed && !state.appointments.length">No upcoming confirmed appointments found.</p>
      <ul><li v-for="item in state.appointments" :key="item.id"><button type="button" @click="editor.lookup(item.id)">{{ item.serviceNameSnapshot }} · {{ time(item.startAt) }} · {{ item.status }}</button></li></ul>
    </fieldset>
    <article v-if="state.selected">
      <h3>{{ state.selected.serviceNameSnapshot }}</h3>
      <dl><dt>Customer</dt><dd>{{ entry?.customerName || entry?.customerPhone || 'Customer unavailable' }}<template v-if="entry?.customerName && entry.customerPhone"><br>{{ entry.customerPhone }}</template></dd><dt>Location</dt><dd>{{ location?.name }} · {{ location?.timezone }}</dd><dt>Professional</dt><dd>{{ entry?.professionalName || state.selected.employeeId }}</dd><dt>Time</dt><dd>{{ time(state.selected.startAt) }} – {{ time(state.selected.endAt) }}</dd><dt>Price at booking</dt><dd>{{ priceText({ amountMinor: state.selected.priceAmountMinor, currency: state.selected.priceCurrency }) }} {{ state.selected.priceCurrency }}</dd><dt>Status</dt><dd>{{ appointmentStatusLabel(state.selected.outcomeStatus ?? state.selected.status) }}</dd></dl>
      <p v-if="['FAILED', 'PENDING_CONFIRMATION'].includes(state.selected.status)" role="status">This booking needs review. Check the calendar with your administrator before creating another appointment.</p>
      <p><strong>Cancellation:</strong> {{ notice(location?.minimumCancellationNoticeMinutes) }}.<br><strong>Rescheduling:</strong> {{ notice(location?.minimumRescheduleNoticeMinutes) }}.</p>
      <fieldset v-if="state.selected.status === 'CONFIRMED' && !readOnly" :disabled="state.busy">
        <legend>Change appointment</legend>
        <button v-if="location?.cancellationAllowed !== false" type="button" @click="state.pending = { kind: 'cancel' }; state.slots = []; searched = false">Cancel appointment…</button>
        <form v-if="location?.reschedulingAllowed !== false" @submit.prevent="findSlots"><label>New date at this location<input v-model="day" type="date" required @change="state.slots = []; state.pending = undefined; searched = false"></label><button>Find reschedule slots</button></form>
        <p>Rescheduling keeps the same service and professional. Only available slots are offered.</p>
        <p v-if="searched && !state.slots.length">No available times found. Try another date.</p>
        <div class="reschedule-slots"><button v-for="slot in state.slots" :key="slot.startAt" type="button" @click="state.pending = { kind: 'reschedule', startAt: slot.startAt }">{{ time(slot.startAt) }}<small v-if="slot.outsideRequestedRange">Outside the requested date</small></button></div>
        <div v-if="state.pending" class="confirmation"><p>{{ state.pending.kind === 'cancel' ? 'Cancel this appointment?' : `Reschedule this appointment to ${time(state.pending.startAt!)}?` }}</p><button type="button" @click="confirm">Confirm {{ state.pending.kind === 'cancel' ? 'cancellation' : 'reschedule' }}</button><button type="button" @click="state.pending = undefined">Keep appointment</button></div>
      </fieldset>
      <details><summary>Appointment reference</summary><p>{{ state.selected.id }}</p></details>
    </article>
  </section>
</template>
<style scoped>
.appointment-admin button{min-height:44px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--blue-ink);font-weight:600}.appointment-admin button:disabled{opacity:.5;cursor:not-allowed}.appointment-admin button:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
.appointment-admin{max-width:1000px;margin:auto}.appointment-admin fieldset,.appointment-admin article{border:1px solid #b9c3cd;border-radius:12px;padding:22px;margin:20px 0;min-width:0}.appointment-admin label{display:grid;gap:6px;margin:12px 0}.appointment-admin input,.appointment-admin select{padding:10px}.appointment-admin button{margin:6px}.appointment-admin dt{font-weight:bold}.appointment-admin dd{margin:0 0 12px;overflow-wrap:anywhere}.appointment-admin p{line-height:1.5;overflow-wrap:anywhere}.confirmation{border:1px solid #b9c3cd;padding:14px}.appointment-admin [role=alert]{color:#7b2424}.appointment-admin [role=status]{color:#24613c}.reschedule-slots{display:flex;flex-wrap:wrap}.reschedule-slots button{display:grid;gap:5px;text-align:left}.reschedule-slots small{font-weight:600;color:#755700}@media(max-width:600px){.appointment-admin article,.appointment-admin fieldset{padding:14px}.appointment-admin button{max-width:100%;margin:6px 0}.reschedule-slots{display:grid;gap:8px}}
</style>
