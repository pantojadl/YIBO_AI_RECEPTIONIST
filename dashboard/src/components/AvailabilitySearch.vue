<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import type { Appointment, Customer, Slot } from "../services/api";
import { createAvailabilitySearch, availabilityTime, slotKey, type AvailabilityPreferences } from "../services/availability-search";
import { useUnsavedChanges } from "../services/unsaved-changes";

const props = defineProps<{ customer?: Customer; readOnly?: boolean; canManageSettings: boolean; initialPreferences?: AvailabilityPreferences; autoSearch?: boolean }>();
const emit = defineEmits<{ booked: [appointment: Appointment]; customerNeeded: []; settings: [locationId: string]; busy: [value: boolean] }>();
const search = createAvailabilitySearch();
const { state, location, service, professionals } = search;
useUnsavedChanges(() => false, () => state.booking);
const groups = computed(() => [
  { key: "requested", title: "Within your requested period", slots: search.requested.value },
  { key: "alternatives", title: "Alternatives outside your requested period", slots: search.alternatives.value },
]);
const time = (instant: string) => availabilityTime(instant, location.value?.timezone ?? "UTC");
const professional = (slot: Slot) => location.value?.professionals.find(item => item.id === slot.employeeId)?.displayName ?? "Professional";
async function book() {
  if (!props.customer || props.readOnly) return;
  const appointment = await search.book(props.customer.id);
  if (appointment) emit("booked", appointment);
}
watch(() => state.booking, value => emit("busy", value), { flush: "sync" });
onMounted(async () => { await search.load(props.initialPreferences); if (props.autoSearch && state.loaded) await search.search(); });
onBeforeUnmount(search.dispose);
</script>

<template>
  <section class="availability-search" aria-labelledby="availability-title">
    <div class="section-heading"><div><p class="eyebrow">Availability</p><h2 id="availability-title">Find an appointment time</h2>
      <p v-if="location">All dates and times use <strong>{{ location.timezone }}</strong>.</p></div>
      <button v-if="canManageSettings" type="button" :disabled="state.booking" @click="emit('settings', state.filters.locationId)">Manage availability settings</button>
    </div>
    <p v-if="state.metadataError" role="alert">{{ state.metadataError }}</p>
    <p v-if="state.loadingLocations" role="status">Loading locations, services and professionals…</p>
    <button v-if="state.metadataError" :disabled="state.loadingLocations" @click="search.load()">Retry loading choices</button>
    <p v-if="state.loaded && !state.locations.length" role="status">No active locations are available. Ask your administrator to configure a location.</p>
    <form v-if="state.loaded && state.locations.length" @submit.prevent="search.search()">
      <fieldset :disabled="state.booking || state.loadingLocations">
        <legend>Search preferences</legend>
        <div class="filters-grid">
          <label>Location<select v-model="state.filters.locationId" required><option v-for="item in state.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label>Service<select v-model="state.filters.serviceId" required><option v-for="item in location?.services" :key="item.id" :value="item.id">{{ item.name }} · {{ item.durationMinutes }} min</option></select></label>
          <label>Professional<select v-model="state.filters.employeeId" :disabled="!professionals.length"><option value="">Any eligible professional</option><option v-for="item in professionals" :key="item.id" :value="item.id">{{ item.displayName }}</option></select></label>
          <label>Date<input v-model="state.filters.day" type="date" required></label>
          <label>Preferred start time<input v-model="state.filters.startTime" type="time" :required="Boolean(state.filters.endTime)"></label>
          <label>Preferred end time<input v-model="state.filters.endTime" type="time" :required="Boolean(state.filters.startTime)"></label>
        </div>
        <p>Leave both times empty to search the whole day. A preferred time range stays within the selected date.</p>
        <p v-if="location && !location.services.length">No active services are offered at this location.</p>
        <p v-else-if="service && !professionals.length">No active professionals are assigned to this service at this location.</p>
        <p v-if="location?.availabilitySuggestions.enabled" class="policy-note">When the requested period has few options, also search up to {{ location.availabilitySuggestions.expansionDays }} {{ location.availabilitySuggestions.expansionDays === 1 ? 'day' : 'days' }} ahead and offer up to {{ location.availabilitySuggestions.maximumAlternatives }} {{ location.availabilitySuggestions.maximumAlternatives === 1 ? 'alternative' : 'alternatives' }}.</p>
        <p v-else class="policy-note">Only the requested period will be searched. Alternative suggestions are off for this location.</p>
        <button class="primary" :disabled="!service || !professionals.length || state.phase === 'loading'">{{ state.phase === 'loading' ? 'Searching…' : 'Search availability' }}</button>
      </fieldset>
    </form>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.booking" role="status">Booking appointment…</p>
    <p v-else-if="state.phase === 'loading'" role="status">Checking current availability…</p>
    <p v-else-if="state.phase === 'idle' && state.loaded && !state.error">Choose your preferences and search to see verified appointment times.</p>
    <div v-if="state.phase === 'results'" class="results">
      <p role="status">{{ search.requested.value.length }} {{ search.requested.value.length === 1 ? 'option' : 'options' }} in your requested period · {{ search.alternatives.value.length }} {{ search.alternatives.value.length === 1 ? 'alternative' : 'alternatives' }}.</p>
      <p>Looking for a later time? Set a preferred time range. Results follow this location’s search limit.</p>
      <p v-if="!state.slots.length">No times found for these preferences. Try a different date, time range or professional.</p>
      <p v-else-if="!search.requested.value.length">No times were found in your requested period. The alternatives below are outside it.</p>
      <template v-for="group in groups" :key="group.key">
        <section v-if="group.slots.length" :aria-labelledby="`availability-${group.key}`">
          <h3 :id="`availability-${group.key}`">{{ group.title }}</h3>
          <div class="slot-grid"><button v-for="slot in group.slots" :key="slotKey(slot)" type="button" class="slot-option" :class="{ selected: state.selected && slotKey(state.selected) === slotKey(slot) }" :aria-pressed="Boolean(state.selected && slotKey(state.selected) === slotKey(slot))" @click="search.select(slot)">
            <strong>{{ time(slot.startAt) }}</strong><span>Until {{ time(slot.endAt) }}</span><span>{{ professional(slot) }}</span>
          </button></div>
        </section>
      </template>
    </div>
    <section v-if="state.selected" class="selection" aria-label="Review selected appointment">
      <h3>Selected appointment</h3><p v-if="state.selected.outsideRequestedRange"><strong>This option is outside your requested period.</strong></p>
      <p>{{ service?.name }} at {{ location?.name }} with {{ professional(state.selected) }}</p><p>{{ time(state.selected.startAt) }} — {{ time(state.selected.endAt) }}</p>
      <p v-if="readOnly">Your role allows viewing availability only.</p>
      <template v-else-if="customer"><p>For {{ customer.name || 'Selected customer' }} · {{ customer.phone }}</p><p>The time is rechecked when you book. Selecting it does not reserve it.</p><button class="primary" :disabled="state.booking" @click="book">Book selected appointment</button></template>
      <template v-else><p>Select or create a customer before booking.</p><button type="button" @click="emit('customerNeeded')">Choose customer</button></template>
    </section>
  </section>
</template>

<style scoped>
.availability-search{max-width:1100px;margin:auto}.availability-search fieldset,.selection{border:1px solid #b9c3cd;border-radius:12px;padding:22px;margin:20px 0;min-width:0}.filters-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.availability-search label{display:grid;gap:6px}.availability-search input,.availability-search select{width:100%;box-sizing:border-box;min-width:0;padding:10px}.policy-note{color:#49617b}.slot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,255px),1fr));gap:12px}.slot-option{display:grid;gap:8px;text-align:left;padding:16px;border:1px solid #b9c3cd;border-radius:12px;background:#fff;color:#18314f;overflow-wrap:anywhere}.slot-option.selected{border:2px solid #2354d7;background:#edf4ff}.slot-option:focus-visible{outline:3px solid #2354d7;outline-offset:3px}.availability-search [role=alert]{padding:14px;background:#fff0ef;color:#7b2424}.results section{margin:22px 0}.selection{background:#f2f7ff}.availability-search p{line-height:1.5}@media(max-width:750px){.filters-grid{grid-template-columns:1fr}.availability-search .section-heading{flex-wrap:wrap;gap:12px}}
</style>
