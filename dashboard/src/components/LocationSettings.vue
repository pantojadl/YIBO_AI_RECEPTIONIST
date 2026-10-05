<script setup lang="ts">
import { useUnsavedChanges } from "../services/unsaved-changes";
import { computed, onMounted, ref } from "vue";
import { createLocationEditor, newLocation, updateAvailabilitySuggestions, initializeLocationControls } from "../services/location-editor";
import { DEFAULT_AVAILABILITY_SUGGESTIONS, type AvailabilitySuggestionsPolicy } from "../../../src/modules/business/domain/multi-location-business.js";
import LocationAgentRules from "./LocationAgentRules.vue";

const props = defineProps<{ initialLocationId?: string }>();
const emit = defineEmits<{ saved: [] }>();
const editor = createLocationEditor();
const { state } = editor;
useUnsavedChanges(() => editor.dirty.value, () => state.busy);
const selectedId = ref(props.initialLocationId ?? "");
const location = computed(() => state.draft?.locations.find(({ id }) => id === selectedId.value));
const suggestions = computed(() => location.value?.policies.availabilitySuggestions ?? DEFAULT_AVAILABILITY_SUGGESTIONS);
function changeSuggestions(patch: Partial<AvailabilitySuggestionsPolicy>) {
  if (location.value) updateAvailabilitySuggestions(location.value, patch);
}
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const addressFields = [
  { key: "line1", label: "Street address", required: true }, { key: "line2", label: "Address line 2", required: false },
  { key: "city", label: "City", required: true }, { key: "administrativeArea", label: "State / province", required: false },
  { key: "postalCode", label: "Postal code", required: false }, { key: "countryCode", label: "Country code (US, MX…)", required: true },
] as const;
const policyFields = [
  { key: "minimumLeadTimeMinutes", label: "Minimum booking lead time (minutes)", min: 0 },
  { key: "maximumBookingHorizonDays", label: "Booking horizon (days)", min: 1 },
  { key: "maximumResults", label: "Maximum availability results", min: 1 },
  { key: "minimumCancellationNoticeMinutes", label: "Cancellation notice (minutes)", min: 0 },
  { key: "minimumRescheduleNoticeMinutes", label: "Rescheduling notice (minutes)", min: 0 },
  { key: "concurrentCapacity", label: "Simultaneous appointments at this location", min: 1 },
] as const;
async function load() {
  await editor.load();
  if (!state.draft?.locations.some(({ id }) => id === selectedId.value)) selectedId.value = state.draft?.locations[0]?.id ?? "";
}
async function save() { if (await editor.save()) emit("saved"); }
function addLocation() {
  if (!location.value || !state.draft) return;
  const added = newLocation(location.value, crypto.randomUUID());
  initializeLocationControls(added); state.draft.locations.push(added); selectedId.value = added.id; state.saved = false;
}
function addClosure() {
  location.value?.closures.push({ id: crypto.randomUUID(), startLocal: "", endLocal: "", administrativeReason: "" });
}
function changeTransfer(event: Event) {
  if (!location.value) return;
  const type = (event.target as HTMLSelectElement).value;
  if (type === "PHONE_NUMBER" || type === "EXTENSION") location.value.transferDestination = { type, value: "" };
  else delete location.value.transferDestination;
}
onMounted(load);
</script>

<template>
  <section class="location-settings" aria-labelledby="locations-title">
    <header class="settings-intro"><div><p class="eyebrow">Business settings</p><h2 id="locations-title">Locations & operating rules</h2><p>Everything the secretary and phone agent use to run this location.</p></div><span>Changes apply to new conversations and availability checks</span></header>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.saved" role="status">Location settings saved.</p>
    <button v-if="!state.draft || state.conflict" type="button" :disabled="state.busy" @click="load">{{ state.conflict ? 'Discard draft and load latest settings' : 'Retry loading' }}</button>
    <form v-if="state.draft" @submit.prevent="save" @input="state.saved = false" @change="state.saved = false">
      <fieldset class="settings-shell" :disabled="state.busy">
        <legend>Location settings · version {{ state.version }}</legend>
        <div class="location-toolbar"><label>Location<select v-model="selectedId"><option v-for="item in state.draft.locations" :key="item.id" :value="item.id">{{ item.name }}{{ item.active ? '' : ' (inactive)' }}</option></select></label>
        <button type="button" @click="addLocation">Add inactive location</button></div>
        <p class="help">A new location copies service offerings and booking policies, but starts with no phone numbers, professionals or calendar mapping. AI rules inherit business settings. Set up those assignments before activating it.</p>
        <template v-if="location">
          <div class="fields identity-fields">
            <label>Name<input v-model="location.name" required></label>
            <label class="check"><input v-model="location.active" type="checkbox">Active</label>
            <label>Time zone (IANA)<input v-model="location.timezone" required placeholder="America/Denver"></label>
            <label>Locale<input v-model="location.locale" required placeholder="en-US"></label>
            <label v-for="field in addressFields" :key="field.key">{{ field.label }}<input v-model="location.address[field.key]" :required="field.required" :maxlength="field.key === 'countryCode' ? 2 : undefined"></label>
          </div>
          <h3>Phone numbers</h3>
          <p class="help">Use international numbers, such as +19155550123. Each number belongs to one active location. Remove its numbers before deactivating a location.</p>
          <div v-for="(_, index) in location.calledNumbers" :key="index" class="row">
            <label>Phone {{ index + 1 }}<input v-model="location.calledNumbers[index]" type="tel" required></label>
            <button type="button" :aria-label="`Remove phone ${index + 1}`" @click="location.calledNumbers.splice(index, 1)">Remove</button>
          </div>
          <button type="button" @click="location.calledNumbers.push('')">Add phone number</button>
          <h3>Weekly hours</h3>
          <p class="help">Times use this location’s time zone. Add separate rows for split shifts. Days without rows are closed.</p>
          <div v-for="(hours, index) in location.openingHours" :key="index" class="row">
            <label>Day<select v-model.number="hours.dayOfWeek"><option v-for="(day, number) in days" :key="day" :value="number">{{ day }}</option></select></label>
            <label>Opens<input v-model="hours.startTime" type="time" required></label>
            <label>Closes<input v-model="hours.endTime" type="time" required></label>
            <button type="button" :aria-label="`Remove hours row ${index + 1}`" @click="location.openingHours.splice(index, 1)">Remove</button>
          </div>
          <button type="button" @click="location.openingHours.push({ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' })">Add hours</button>
          <h3>Closures</h3>
          <p class="help">Closure dates and times are local to this location. Reasons are administrative only.</p>
          <div v-for="(closure, index) in location.closures" :key="closure.id" class="closure">
            <label>From<input v-model="closure.startLocal" type="datetime-local" required></label>
            <label>Until<input v-model="closure.endLocal" type="datetime-local" required></label>
            <label>Administrative reason<input v-model="closure.administrativeReason" required></label>
            <button type="button" :aria-label="`Remove closure ${index + 1}`" @click="location.closures.splice(index, 1)">Remove closure</button>
          </div>
          <button type="button" @click="addClosure">Add closure</button>
          <h3>Booking policies</h3>
          <div class="fields">
            <label>Default service<select v-model="location.policies.defaultServiceId" required><option v-for="assignment in location.services.filter(item => item.active)" :key="assignment.serviceId" :value="assignment.serviceId">{{ state.draft.services.find(service => service.id === assignment.serviceId)?.name ?? assignment.serviceId }}</option></select></label>
            <label>Slot interval (minutes)<select v-model.number="location.policies.slotIncrementMinutes"><option v-for="minutes in [5, 10, 15, 20, 30, 45, 60]" :key="minutes" :value="minutes">{{ minutes }}</option></select></label>
            <label v-for="field in policyFields" :key="field.key">{{ field.label }}<input v-model.number="location.policies[field.key]" type="number" :min="field.min" step="1" required></label>
          </div>
          <h3>Availability suggestions</h3>
          <p class="help">Keep the requested period first. When it has few or no options, optionally offer verified alternatives after that period. These settings apply to availability searches and the agent at this location.</p>
          <label class="check"><input type="checkbox" :checked="suggestions.enabled" @change="changeSuggestions({ enabled: ($event.target as HTMLInputElement).checked })">Offer alternatives outside the requested period</label>
          <div class="fields">
            <label>Search ahead (days)<input type="number" min="1" max="14" step="1" required :disabled="!suggestions.enabled" :value="suggestions.expansionDays" @input="changeSuggestions({ expansionDays: Number(($event.target as HTMLInputElement).value) })"></label>
            <label>Maximum alternative options<input type="number" min="1" max="5" step="1" required :disabled="!suggestions.enabled" :value="suggestions.maximumAlternatives" @input="changeSuggestions({ maximumAlternatives: Number(($event.target as HTMLInputElement).value) })"></label>
          </div>
          <p class="help">Search ahead uses 24-hour periods after the requested end. Business hours, provider schedules, booking limits and Calendar conflicts still apply. No appointment is chosen automatically.</p>
          <LocationAgentRules :location="location" />
          <div class="toggle-grid">
            <label class="check"><input v-model="location.policies.sameDayBooking" type="checkbox">Allow same-day booking</label>
            <label class="check"><input v-model="location.policies.cancellationAllowed" type="checkbox">Allow cancellation</label>
            <label class="check"><input v-model="location.policies.reschedulingAllowed" type="checkbox">Allow rescheduling</label>
            <label class="check"><input v-model="location.policies.staffOverrideAllowed" type="checkbox">Allow authorized staff overrides</label>
          </div>
          <h3>AI permissions</h3>
          <p class="help">These additional restrictions combine with Business rules and the location overrides above; a disabled permission always wins. Turning a capability off removes or restricts the corresponding action.</p>
          <div v-if="location.aiCapabilities" class="toggle-grid ai-toggle-grid">
            <label class="check"><input v-model="location.aiCapabilities.bookAppointments" type="checkbox">Book appointments</label>
            <label class="check"><input v-model="location.aiCapabilities.rescheduleAppointments" type="checkbox">Reschedule appointments</label>
            <label class="check"><input v-model="location.aiCapabilities.cancelAppointments" type="checkbox">Cancel appointments</label>
            <label class="check"><input v-model="location.aiCapabilities.describeServices" type="checkbox">Describe services</label>
            <label class="check"><input v-model="location.aiCapabilities.quotePrices" type="checkbox">Quote prices</label>
            <label class="check"><input v-model="location.aiCapabilities.offerEarliest" type="checkbox">Offer earliest availability</label>
            <label class="check"><input v-model="location.aiCapabilities.offerAlternatives" type="checkbox">Offer multiple alternatives</label>
            <label class="check"><input v-model="location.aiCapabilities.collectPhone" type="checkbox">Collect callback phone</label>
            <label class="check"><input v-model="location.aiCapabilities.collectEmail" type="checkbox">Collect email address</label>
            <label class="check"><input v-model="location.aiCapabilities.sendAppointmentEmails" type="checkbox">Send appointment emails</label>
            <label class="check"><input v-model="location.aiCapabilities.transferToHuman" type="checkbox">Transfer to a human</label>
            <label>After-hours behavior<select v-model="location.aiCapabilities.afterHoursBehavior"><option value="INFORMATION_ONLY">Information only</option><option value="BOOK">Allow booking</option><option value="TRANSFER">Transfer</option></select></label>
          </div>
          <h3>Human transfer</h3>
          <div class="fields">
            <label>Destination type<select :value="location.transferDestination?.type ?? ''" @change="changeTransfer"><option value="">No destination</option><option value="PHONE_NUMBER">Phone number</option><option value="EXTENSION">Extension</option></select></label>
            <label v-if="location.transferDestination">{{ location.transferDestination.type === 'EXTENSION' ? 'Extension (digits)' : 'Phone number (international format)' }}<input v-model="location.transferDestination.value" required></label>
          </div>
        </template>
        <button class="primary save" :disabled="!editor.canSave.value">{{ state.busy ? 'Saving…' : 'Save location settings' }}</button>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
.location-settings{max-width:1200px;margin:auto}.settings-intro{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:24px}.settings-intro p:last-child{color:var(--muted)}.settings-intro>span{max-width:270px;padding:11px 15px;border:1px solid var(--line);border-radius:15px 6px;color:var(--muted);background:#fffaf2;font-size:11px;line-height:1.4}.location-settings .settings-shell{margin:0;padding:0 26px 28px;border:1px solid var(--line);border-radius:7px 26px 8px 18px;background:#fffaf2;box-shadow:0 16px 40px #483f2d0d}.settings-shell>legend{padding:0 12px;color:var(--blue);font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.location-toolbar{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:12px;align-items:end;padding:22px 0 18px;border-bottom:1px solid var(--line)}.location-toolbar button,.row button,.closure button,.location-settings button:not(.primary){min-height:40px;padding:9px 13px;border:1px solid #c5bdaf;border-radius:7px 13px;color:#405071;background:#f8f3ea}.location-settings label{display:grid;gap:6px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:18px 0}.identity-fields{padding:20px;border:1px solid #ded7cb;border-radius:17px 6px;background:#f8f4ec}.location-settings input:not([type=checkbox]),.location-settings select{width:100%;box-sizing:border-box;padding:11px;min-width:0}.row,.closure{display:flex;flex-wrap:wrap;align-items:end;gap:12px;padding:14px;margin-bottom:10px;border:1px solid #e1d9cd;border-radius:13px 5px;background:#faf6ee}.row label,.closure label{flex:1;min-width:130px}.toggle-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:17px 0 28px}.toggle-grid .check{display:grid;grid-template-columns:22px 1fr;align-items:center;gap:12px;min-height:58px;padding:13px 15px;border:1px solid #d8d1c5;border-radius:14px 5px;background:#fbf7ef;font-size:12px}.toggle-grid .check input{width:18px;height:18px;margin:0;accent-color:var(--blue)}.ai-toggle-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.ai-toggle-grid>label:not(.check){grid-column:1/-1;padding:14px;border:1px solid #d8d1c5;border-radius:14px 5px;background:#edf2f8}.help{max-width:850px;color:var(--muted);font-size:.86rem;line-height:1.5}.location-settings h3{margin:34px -26px 0;padding:18px 26px 11px;border-top:1px solid var(--line);color:var(--blue-deep);font-size:24px}.location-settings h3+.help{margin-top:0}.save{position:sticky;bottom:18px;z-index:2;width:100%;margin-top:28px}.location-settings [role=alert]{padding:14px;background:#fff0ef;color:#7b2424;border:1px solid #cf8b83}.location-settings [role=status]{color:#24613c}@media(max-width:850px){.ai-toggle-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){.settings-intro{align-items:flex-start;flex-direction:column}.fields,.toggle-grid,.ai-toggle-grid,.location-toolbar{grid-template-columns:1fr}.location-settings .settings-shell{padding-inline:17px}.location-settings h3{margin-inline:-17px;padding-inline:17px}}
</style>
