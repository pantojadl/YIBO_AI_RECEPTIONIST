<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, type Appointment, type AppointmentLocation, type Customer, type DirectoryProfessional, type Slot } from "../services/api";

const props = defineProps<{ customer?: Customer; readOnly?: boolean }>();
const emit = defineEmits<{ booked: [appointment: Appointment] }>();
const locations = ref<AppointmentLocation[]>([]); const directory = ref<DirectoryProfessional[]>([]);
const locationId = ref(""); const serviceId = ref(""); const date = ref(nextWeekday());
const slotsByDoctor = ref<Record<string, Slot[]>>({}); const busy = ref(false); const searched = ref(false); const error = ref("");
const location = computed(() => locations.value.find(({ id }) => id === locationId.value));
const service = computed(() => location.value?.services.find(({ id }) => id === serviceId.value));
const doctors = computed(() => (location.value?.professionals ?? []).filter(({ serviceIds }) => serviceIds.includes(serviceId.value)));
const patientCount = (id: string) => directory.value.find((doctor) => doctor.id === id)?.patientIds.length ?? 0;
async function load() { const [metadata, people] = await Promise.all([api.appointmentLocations(), api.officeDirectory()]);
  locations.value = metadata.locations.filter(({ active }) => active); directory.value = people.professionals;
  locationId.value ||= locations.value[0]?.id ?? ""; serviceId.value ||= location.value?.services[0]?.id ?? ""; }
function locationChanged() { serviceId.value = location.value?.services[0]?.id ?? ""; slotsByDoctor.value = {}; searched.value = false; }
async function search() { if (!location.value || !serviceId.value) return; busy.value = true; error.value = ""; searched.value = true; try {
  const rangeStart = zonedStart(date.value, location.value.timezone); const next = new Date(`${date.value}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const entries = await Promise.all(doctors.value.map(async (doctor) => [doctor.id, (await api.availability({ locationId: locationId.value,
    serviceId: serviceId.value, employeeId: doctor.id, rangeStart, rangeEnd: zonedStart(next.toISOString().slice(0,10), location.value!.timezone) })).slots] as const));
  slotsByDoctor.value = Object.fromEntries(entries);
} catch (caught) { error.value = caught instanceof Error ? caught.message : "Could not load availability."; } finally { busy.value = false; } }
async function book(slot: Slot) {
  if (!props.customer || props.readOnly || busy.value) return;
  const idempotencyKey = crypto.randomUUID();
  busy.value = true;
  try {
    const appointment = await api.createAppointment({
      locationId: locationId.value, customerId: props.customer.id, serviceId: serviceId.value,
      employeeId: slot.employeeId, startAt: slot.startAt, idempotencyKey,
    });
    emit("booked", appointment); await search();
  } finally { busy.value = false; }
}
const time = (value: string) => new Intl.DateTimeFormat("en", { timeZone: location.value?.timezone ?? "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(value));
function nextWeekday() { const value = new Date(); value.setDate(value.getDate() + 1); while ([0,6].includes(value.getDay())) value.setDate(value.getDate() + 1); return value.toISOString().slice(0,10); }
function zonedStart(day: string, timezone: string) { const [year, month, date] = day.split("-").map(Number); const wall = Date.UTC(year, month - 1, date); let instant = wall;
  for (let i=0;i<3;i++){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(instant)); const n=(type:Intl.DateTimeFormatPartTypes)=>Number(parts.find(part=>part.type===type)?.value); instant=wall-(Date.UTC(n("year"),n("month")-1,n("day"),n("hour"),n("minute"))-instant);} return new Date(instant).toISOString(); }
onMounted(async () => { try { await load(); } catch (caught) { error.value = caught instanceof Error ? caught.message : "Could not load professionals."; } });
</script>

<template>
  <section class="availability-board"><header class="availability-heading"><div><p class="eyebrow">Team availability</p><h2>Every doctor, side by side</h2><p>Compare the whole team without opening each professional separately.</p></div><span v-if="customer" class="selected-patient">Booking for <strong>{{ customer.name || customer.phone }}</strong></span><span v-else class="selected-patient muted">Select a patient in Customers to book</span></header>
    <p v-if="error" class="alert">{{ error }}</p>
    <div class="availability-controls panel"><label>Location<select v-model="locationId" @change="locationChanged"><option v-for="item in locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>Service<select v-model="serviceId" @change="slotsByDoctor={}; searched=false"><option v-for="item in location?.services" :key="item.id" :value="item.id">{{ item.name }} · {{ item.durationMinutes }} min</option></select></label>
      <label>Date<input v-model="date" type="date" @change="slotsByDoctor={}; searched=false"></label><button class="primary" :disabled="busy" @click="search">{{ busy ? 'Checking…' : 'Show all availability' }}</button></div>
    <div class="coverage-strip"><span><strong>{{ doctors.length }}</strong> professionals</span><span><strong>{{ service?.durationMinutes ?? 0 }}</strong> minute visit</span><span><strong>{{ Object.values(slotsByDoctor).reduce((sum, values) => sum + values.length, 0) }}</strong> open times</span><span><strong>{{ location?.timezone }}</strong> local time</span></div>
    <div class="doctor-grid">
      <article v-for="doctor in doctors" :key="doctor.id" class="doctor-card panel"><header><span class="doctor-mark">{{ doctor.name.split(' ').map(part=>part[0]).slice(0,2).join('') }}</span><div><p class="eyebrow">Professional</p><h3>{{ doctor.name }}</h3><small>{{ patientCount(doctor.id) }} patients in directory</small></div><span :class="['availability-count',{open:(slotsByDoctor[doctor.id]?.length ?? 0)>0}]">{{ searched ? `${slotsByDoctor[doctor.id]?.length ?? 0} open` : 'Not checked' }}</span></header>
        <div v-if="slotsByDoctor[doctor.id]?.length" class="doctor-slots"><button v-for="slot in slotsByDoctor[doctor.id]" :key="slot.startAt" :disabled="readOnly || !customer || busy" @click="book(slot)"><strong>{{ time(slot.startAt) }}</strong><small>{{ time(slot.endAt) }}</small></button></div>
        <div v-else-if="searched" class="doctor-empty">No open times for this date.</div><div v-else class="doctor-empty">Run availability to see this doctor’s day.</div>
      </article><div v-if="!doctors.length" class="empty">No professionals are assigned to this service.</div>
    </div>
  </section>
</template>

<style scoped>
.availability-heading{display:flex;justify-content:space-between;align-items:end;gap:30px;margin-bottom:22px}.availability-heading p:last-child{color:var(--muted)}.selected-patient{padding:12px 16px;border:1px solid #aec5b5;border-radius:16px 6px;background:#e5efe6;color:#315d3e}.selected-patient.muted{border-color:var(--line);background:#fffaf2;color:var(--muted)}.availability-controls{display:grid;grid-template-columns:1fr 1.35fr 1fr auto;align-items:end;gap:12px;padding:18px}.availability-controls button{min-height:43px}.coverage-strip{display:grid;grid-template-columns:repeat(4,1fr);margin:16px 0;border:1px solid var(--line);border-radius:6px 18px;background:#fffaf2;overflow:hidden}.coverage-strip span{display:flex;align-items:baseline;gap:7px;padding:13px 18px;border-right:1px solid var(--line);color:var(--muted);font-size:10px}.coverage-strip span:last-child{border:0}.coverage-strip strong{color:var(--blue-deep);font:500 20px Georgia,serif}.doctor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.doctor-card{padding:0;overflow:hidden}.doctor-card>header{min-height:105px;padding:20px;display:grid;grid-template-columns:48px 1fr auto;gap:13px;align-items:center;border-bottom:1px solid var(--line);background:linear-gradient(120deg,#fffaf2,#edf2f8)}.doctor-mark{display:grid;place-items:center;width:46px;height:46px;border-radius:17px 7px;color:white;background:var(--blue);font:600 17px Georgia,serif}.doctor-card h3{margin:0 0 4px}.doctor-card small{color:var(--muted)}.availability-count{padding:6px 9px;border-radius:99px;color:#73776f;background:#e6e2db;font-size:9px;font-weight:800;text-transform:uppercase}.availability-count.open{color:#276143;background:#dcecdf}.doctor-slots{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:18px}.doctor-slots button{display:grid;gap:3px;padding:11px 8px;border:1px solid #b8c9dc;border-radius:8px 15px;color:var(--blue-deep);background:#f8fbff}.doctor-slots button:hover:not(:disabled){color:white;background:var(--blue)}.doctor-slots button:disabled{opacity:.5}.doctor-slots small{font-size:9px}.doctor-empty{display:grid;place-items:center;min-height:105px;padding:20px;color:var(--muted)}@media(max-width:900px){.availability-controls,.coverage-strip{grid-template-columns:1fr 1fr}.doctor-grid{grid-template-columns:1fr}}@media(max-width:620px){.availability-heading{align-items:flex-start;flex-direction:column}.availability-controls,.coverage-strip{grid-template-columns:1fr}.doctor-slots{grid-template-columns:repeat(2,1fr)}}
</style>
