<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { appointmentErrorMessage } from "../services/appointment-editor";
import { api, type Appointment, type AppointmentEvent, type AppointmentLocation, type Customer,
  type NotificationDelivery, type Slot } from "../services/api";

const props = defineProps<{ readOnly?: boolean }>();
type ViewMode = "day" | "week" | "month" | "agenda";
const view = ref<ViewMode>("day"); const date = ref(new Date().toISOString().slice(0, 10));
const locations = ref<AppointmentLocation[]>([]); const locationId = ref("");
const serviceId = ref(""); const employeeId = ref(""); const status = ref("");
const appointments = ref<Appointment[]>([]); const slots = ref<Slot[]>([]); const busy = ref(false); const error = ref("");
const selected = ref<Appointment>(); const events = ref<AppointmentEvent[]>([]); const notifications = ref<NotificationDelivery[]>([]);
const query = ref(""); const customers = ref<Customer[]>([]); const customer = ref<Customer>();
const customerHistory = ref<Appointment[]>([]);
const customerDraft = ref({ name: "", phone: "", email: "", preferredLanguage: "en", emailOptIn: true });
const selectedSlot = ref<Slot>(); const rescheduling = ref(false);
const mutationBusy = ref(false);

const location = computed(() => locations.value.find(({ id }) => id === locationId.value));
const services = computed(() => location.value?.services ?? []);
const professionals = computed(() => (location.value?.professionals ?? []).filter((person) =>
  !serviceId.value || person.serviceIds.includes(serviceId.value)));
const range = computed(() => dateRange(date.value, view.value === "agenda" ? "week" : view.value, location.value?.timezone ?? "UTC"));
const days = computed(() => {
  const grouped = new Map<string, { appointments: Appointment[]; slots: Slot[] }>();
  for (const item of appointments.value) add(item.startAt, "appointments", item);
  for (const item of slots.value) add(item.startAt, "slots", item);
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => ({ day, ...items }));
  function add(value: string, key: "appointments" | "slots", item: Appointment | Slot) {
    const day = localDate(value, location.value?.timezone ?? "UTC");
    const target = grouped.get(day) ?? { appointments: [], slots: [] };
    if (key === "appointments") target.appointments.push(item as Appointment); else target.slots.push(item as Slot);
    grouped.set(day, target);
  }
});

async function load() {
  busy.value = true; error.value = "";
  try {
    if (!locations.value.length) {
      locations.value = (await api.appointmentLocations()).locations.filter(({ active }) => active);
      locationId.value ||= locations.value[0]?.id ?? ""; serviceId.value ||= locations.value[0]?.services[0]?.id ?? "";
    }
    if (!locationId.value) return;
    const result = await api.officeSchedule({ locationId: locationId.value, ...range.value,
      ...(serviceId.value ? { serviceId: serviceId.value } : {}), ...(employeeId.value ? { employeeId: employeeId.value } : {}),
      ...(status.value ? { status: status.value } : {}) });
    appointments.value = result.appointments; slots.value = result.slots;
    if (selected.value) {
      const fresh = appointments.value.find(item => item.id === selected.value?.id);
      if (fresh) await chooseAppointment(fresh); else selected.value = undefined;
    }
  } catch (caught) { error.value = caught instanceof Error ? caught.message : "Could not load the office schedule."; }
  finally { busy.value = false; }
}
function locationChanged() { serviceId.value = location.value?.services[0]?.id ?? ""; employeeId.value = ""; void load(); }
async function search() { customers.value = (await api.searchCustomers(query.value)).customers; }
async function saveCustomer() {
  customer.value = await api.findOrCreateCustomer({ ...customerDraft.value,
    ...(customerDraft.value.email ? { email: customerDraft.value.email } : {}) });
  query.value = customer.value.name ?? customer.value.phone; customers.value = [customer.value];
  customerHistory.value = (await api.customerHistory(customer.value.id)).appointments;
}
async function selectCustomer(value: Customer) { customer.value = value; customerDraft.value = {
  name: value.name ?? "", phone: value.phone, email: value.email ?? "", preferredLanguage: value.preferredLanguage ?? "en",
  emailOptIn: value.emailOptIn !== false }; customerHistory.value = (await api.customerHistory(value.id)).appointments; }
async function chooseAppointment(item: Appointment) {
  selected.value = item; selectedSlot.value = undefined; rescheduling.value = false;
  const timeline = await api.appointmentTimeline(item.locationId, item.id);
  customer.value = await api.customer(item.customerId);
  events.value = timeline.events; notifications.value = timeline.notifications;
}
async function mutate(operation: () => Promise<void>) {
  if (mutationBusy.value || busy.value || props.readOnly) return;
  mutationBusy.value = true; error.value = "";
  try { await operation(); }
  catch (caught) { error.value = appointmentErrorMessage(caught); rescheduling.value = false; }
  finally { mutationBusy.value = false; }
}
async function book(slot: Slot) {
  if (!customer.value || !serviceId.value || props.readOnly) { selectedSlot.value = slot; return; }
  const idempotencyKey = crypto.randomUUID();
  return mutate(async () => {
    await api.createAppointment({ locationId: locationId.value, customerId: customer.value!.id,
      serviceId: serviceId.value, employeeId: slot.employeeId, startAt: slot.startAt, idempotencyKey });
    selectedSlot.value = undefined; await load();
  });
}
async function cancel() {
  const appointment = selected.value; if (!appointment) return;
  return mutate(async () => {
    await api.cancelAppointment(appointment.locationId, appointment.id, appointment.version ?? 1, crypto.randomUUID());
    selected.value = undefined; await load();
  });
}
async function mark(outcome: "COMPLETED" | "NO_SHOW") {
  const appointment = selected.value; if (!appointment) return;
  return mutate(async () => {
    selected.value = await api.markAppointmentOutcome(appointment.locationId, appointment.id, outcome, appointment.version ?? 1);
    await load();
  });
}
async function reschedule(slot: Slot) {
  const appointment = selected.value; if (!appointment) return;
  return mutate(async () => {
    selected.value = await api.rescheduleAppointment(appointment.locationId, appointment.id, slot.startAt, appointment.version ?? 1, crypto.randomUUID());
    rescheduling.value = false; await load();
  });
}
const time = (value: string) => new Intl.DateTimeFormat("en", { timeZone: location.value?.timezone ?? "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(value));
onMounted(load);

function localDate(value: string, timezone: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function dateRange(day: string, mode: Exclude<ViewMode, "agenda">, timezone: string) {
  const base = new Date(`${day}T12:00:00Z`); let start = new Date(base); let end = new Date(base);
  if (mode === "week") { start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); end = new Date(start); end.setUTCDate(end.getUTCDate() + 7); }
  else if (mode === "month") { start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12)); end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 12)); }
  else end.setUTCDate(end.getUTCDate() + 1);
  return { rangeStart: zonedStart(start.toISOString().slice(0, 10), timezone), rangeEnd: zonedStart(end.toISOString().slice(0, 10), timezone) };
}
function zonedStart(day: string, timezone: string) {
  const [year, month, date] = day.split("-").map(Number); const wall = Date.UTC(year, month - 1, date); let instant = wall;
  for (let i = 0; i < 3; i++) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
    const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value); instant = wall - (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) - instant); }
  return new Date(instant).toISOString();
}
</script>

<template>
  <section class="office-workspace">
    <header class="office-heading"><div><p class="eyebrow">Office workspace</p><h1>Schedule & availability</h1><p>Appointments and open slots use the same rules and calendars as the phone agent.</p></div><button :disabled="busy || mutationBusy" @click="load">Refresh</button></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="mutationBusy" role="status">Saving appointment…</p>
    <div class="office-controls">
      <label>View<select v-model="view" :disabled="mutationBusy" @change="load"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="agenda">Agenda</option></select></label>
      <label>Date<input v-model="date" :disabled="mutationBusy" type="date" @change="load"></label>
      <label>Location<select v-model="locationId" :disabled="mutationBusy" @change="locationChanged"><option v-for="item in locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>Service<select v-model="serviceId" :disabled="mutationBusy" @change="employeeId=''; load()"><option value="">All services</option><option v-for="item in services" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>Professional<select v-model="employeeId" :disabled="mutationBusy" @change="load"><option value="">Any professional</option><option v-for="item in professionals" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>Status<select v-model="status" :disabled="mutationBusy" @change="load"><option value="">All statuses</option><option v-for="item in ['CONFIRMED','CANCELLED','COMPLETED','NO_SHOW','FAILED']" :key="item">{{ item }}</option></select></label>
    </div>
    <div class="office-layout">
      <div class="calendar-board" :class="`view-${view}`">
        <article v-for="item in days" :key="item.day" class="calendar-day"><h2>{{ item.day }}</h2>
          <button v-for="appointment in item.appointments" :key="appointment.id" class="appointment-chip" :disabled="busy || mutationBusy" @click="chooseAppointment(appointment)"><strong>{{ time(appointment.startAt) }}</strong> {{ appointment.serviceNameSnapshot }}<small>{{ appointment.outcomeStatus ?? appointment.status }}</small></button>
          <button v-for="slot in item.slots" :key="`${slot.employeeId}-${slot.startAt}`" class="slot-chip" :disabled="readOnly || busy || mutationBusy" @click="rescheduling ? reschedule(slot) : book(slot)">+ {{ time(slot.startAt) }} open</button>
          <p v-if="!item.appointments.length && !item.slots.length">No activity</p>
        </article>
        <p v-if="!days.length && !busy" class="empty">No appointments or open slots in this range.</p>
      </div>
      <aside class="office-panel">
          <template v-if="selected"><h2>{{ selected.serviceNameSnapshot }}</h2><p>{{ time(selected.startAt) }} · {{ selected.outcomeStatus ?? selected.status }}</p><p>Customer: {{ customer?.name || customer?.phone || selected.customerId }}</p>
          <div v-if="!readOnly && selected.status==='CONFIRMED'" class="actions"><button v-if="location?.reschedulingAllowed !== false" :disabled="busy || mutationBusy" @click="rescheduling=!rescheduling">Reschedule</button><button v-if="location?.cancellationAllowed !== false" :disabled="busy || mutationBusy" @click="cancel">Cancel</button><button :disabled="busy || mutationBusy" @click="mark('COMPLETED')">Complete</button><button :disabled="busy || mutationBusy" @click="mark('NO_SHOW')">No-show</button></div>
          <h3>History</h3><ol><li v-for="event in events" :key="event.id">{{ event.type }} · {{ new Date(event.occurredAt).toLocaleString() }}</li></ol>
          <h3>Notifications</h3><ul><li v-for="item in notifications" :key="item.id">{{ item.kind }} · {{ item.status }} · {{ item.destinationMasked }}</li><li v-if="!notifications.length">No notifications recorded.</li></ul>
          <button :disabled="mutationBusy" @click="selected=undefined">Close details</button></template>
        <template v-else><h2>Quick booking</h2><form @submit.prevent="search"><label>Find customer<input v-model="query" placeholder="Name, phone or email"></label><button>Search</button></form>
          <button v-for="item in customers" :key="item.id" class="customer-result" @click="selectCustomer(item)">{{ item.name || 'Unnamed customer' }}<small>{{ item.phone }} · {{ item.email || 'no email' }}</small></button>
          <form v-if="!readOnly" class="customer-form" @submit.prevent="saveCustomer"><h3>New customer</h3><label>Name<input v-model="customerDraft.name"></label><label>Phone<input v-model="customerDraft.phone" required></label><label>Email<input v-model="customerDraft.email" type="email"></label><label>Language<input v-model="customerDraft.preferredLanguage"></label><label class="check"><input v-model="customerDraft.emailOptIn" type="checkbox">Appointment emails</label><button>Create/select customer</button></form>
          <p v-if="customer" class="selected-customer">Selected: <strong>{{ customer.name || customer.phone }}</strong>. Choose an open slot.</p>
          <details v-if="customerHistory.length"><summary>Appointment history ({{ customerHistory.length }})</summary><ul><li v-for="item in customerHistory" :key="item.id">{{ localDate(item.startAt, location?.timezone ?? 'UTC') }} · {{ item.serviceNameSnapshot }} · {{ item.outcomeStatus ?? item.status }}</li></ul></details>
          <p v-if="selectedSlot && !customer">Select or create a customer to book {{ time(selectedSlot.startAt) }}.</p></template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.office-workspace{max-width:1500px;margin:auto}.office-heading{display:flex;justify-content:space-between;gap:24px;align-items:start}.office-heading h1{margin:.2rem 0}.office-controls{display:grid;grid-template-columns:repeat(6,minmax(130px,1fr));gap:12px;padding:16px;background:#f5f7fa;border:1px solid #dce2e8;border-radius:14px;margin:20px 0}.office-controls label,.office-panel label{display:grid;gap:5px;font-size:.82rem;font-weight:700}.office-controls input,.office-controls select,.office-panel input{min-width:0;padding:9px;border:1px solid #b9c3cd;border-radius:8px}.office-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:20px}.calendar-board{display:grid;grid-template-columns:repeat(7,minmax(130px,1fr));gap:10px;align-items:start;overflow:auto}.view-day{grid-template-columns:1fr}.view-agenda{display:block}.view-agenda .calendar-day{margin-bottom:10px}.calendar-day{min-height:150px;padding:12px;border:1px solid #dce2e8;border-radius:12px;background:white}.calendar-day h2{font-size:.9rem;margin:0 0 10px}.appointment-chip,.slot-chip,.customer-result{display:grid;width:100%;text-align:left;margin:6px 0;padding:9px;border-radius:8px;border:0}.appointment-chip{background:#e9efff;color:#203b78}.slot-chip{background:#e8f7ef;color:#155b35;border:1px dashed #63a77e}.appointment-chip small,.customer-result small{display:block;margin-top:3px}.office-panel{border:1px solid #dce2e8;border-radius:14px;padding:18px;background:white;align-self:start;position:sticky;top:20px}.office-panel form{display:grid;gap:10px;margin:12px 0}.customer-result{background:#f3f5f7}.selected-customer{padding:10px;background:#e8f7ef}.actions{display:flex;flex-wrap:wrap;gap:6px}.empty{padding:30px}.check{display:flex!important;align-items:center;grid-template-columns:auto 1fr}@media(max-width:1000px){.office-controls{grid-template-columns:repeat(2,1fr)}.office-layout{grid-template-columns:1fr}.office-panel{position:static}.calendar-board{grid-template-columns:repeat(2,minmax(220px,1fr))}}@media(max-width:620px){.office-controls,.calendar-board{grid-template-columns:1fr}}
</style>
