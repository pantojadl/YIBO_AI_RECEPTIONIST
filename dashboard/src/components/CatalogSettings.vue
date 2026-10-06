<script setup lang="ts">
import { DISPLAY_CURRENCIES, displayCurrency, formatDisplayMoney, formatStoredMoney } from "../services/money-presentation";
import { useUnsavedChanges } from "../services/unsaved-changes";
import { computed, onMounted, ref } from "vue";
import type { TenantServiceDefinition, ProfessionalDefinition, LocationProfessionalAssignment } from "../../../src/modules/business/index.js";
import { createCatalogEditor, copyCatalogValue, priceText } from "../services/catalog-editor";
const emit = defineEmits<{ saved: [] }>();
const editor = createCatalogEditor();
const { state } = editor;
useUnsavedChanges(() => Boolean(draft.value), () => state.busy);
const locationId = ref("");
const configuration = computed(() => state.document?.configuration);
const location = computed(() => configuration.value?.locations.find(item => item.id === locationId.value));
type Draft = { kind: "service"; isNew: boolean; value: TenantServiceDefinition }
  | { kind: "currency"; value: "USD" | "MXN" | "EUR" }
  | { kind: "professional"; isNew: boolean; value: ProfessionalDefinition }
  | { kind: "offering"; serviceId: string; active: boolean; amount: string; currency: string }
  | { kind: "assignment"; value: LocationProfessionalAssignment };
const draft = ref<Draft>();
const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
async function load() {
  if (!await editor.load()) return;
  draft.value = undefined;
  if (!configuration.value?.locations.some(item => item.id === locationId.value)) locationId.value = configuration.value?.locations[0]?.id ?? "";
}
function openService(value?: TenantServiceDefinition) {
  state.saved = false;
  draft.value = { kind: "service", isNew: !value, value: value ? copyCatalogValue(value) : { id: crypto.randomUUID(), name: "", description: "", durationMinutes: 30, bufferMinutes: 0, active: true } };
}
function openProfessional(value?: ProfessionalDefinition) {
  state.saved = false;
  draft.value = { kind: "professional", isNew: !value, value: value ? copyCatalogValue(value) : { id: crypto.randomUUID(), displayName: "", active: true } };
}
function openOffering(serviceId: string) {
  const existing = location.value?.services.find(item => item.serviceId === serviceId);
  state.saved = false;
  draft.value = { kind: "offering", serviceId, active: existing?.active ?? true, amount: existing ? priceText(existing.price) : "0.00", currency: existing?.price.currency ?? displayCurrency(configuration.value) };
}
function openAssignment(professionalId: string) {
  state.saved = false;
  draft.value = { kind: "assignment", value: copyCatalogValue(location.value?.professionals.find(item => item.professionalId === professionalId) ?? { professionalId, active: true, serviceIds: [], openingHours: [] }) };
}
async function save() {
  const form = draft.value;
  if (!form) return;
  const success = form.kind === "service" ? await editor.saveService(form.value, form.isNew)
    : form.kind === "professional" ? await editor.saveProfessional(form.value, form.isNew)
    : form.kind === "offering" ? await editor.saveOffering(locationId.value, form.serviceId, form.active, form.amount, form.currency)
    : form.kind === "currency" ? await editor.saveDisplayCurrency(form.value)
    : await editor.saveAssignment(locationId.value, form.value);
  if (success) { draft.value = undefined; emit("saved"); }
}
function cancel() { draft.value = undefined; state.error = ""; }
onMounted(load);
</script>

<template>
  <section class="catalog-settings" aria-labelledby="catalog-title">
    <h2 id="catalog-title">Services, prices & professionals</h2>
    <p>Catalog entries are shared across locations. Prices, service offerings and professional schedules belong to each location.</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.saved" role="status">Catalog settings saved.</p>
    <button v-if="!state.document || state.conflict" :disabled="state.busy" type="button" @click="load">{{ state.conflict ? 'Discard draft and load latest settings' : 'Retry loading' }}</button>
    <template v-if="configuration">
      <fieldset :disabled="state.busy || Boolean(draft) || state.conflict">
        <legend>Catalogs · version {{ state.document?.version }}</legend>
        <label>Location for offerings and schedules<select v-model="locationId"><option v-for="item in configuration.locations" :key="item.id" :value="item.id">{{ item.name }}{{ item.active ? '' : ' (inactive)' }}</option></select></label>
        <p>Default display currency: {{ displayCurrency(configuration) }} <button type="button" @click="draft = { kind: 'currency', value: displayCurrency(configuration) }">Edit currency</button></p>
        <h3>Services</h3><button type="button" @click="openService()">Add service</button>
        <ul class="entries"><li v-for="service in configuration.services" :key="service.id">
          <div><strong>{{ service.name }}</strong> · {{ service.active ? 'Active' : 'Inactive' }}<p>{{ service.description }}</p><small>{{ service.durationMinutes }} minutes + {{ service.bufferMinutes }} buffer minutes</small>
            <p v-if="location?.services.find(item => item.serviceId === service.id)" class="price">{{ location?.services.find(item => item.serviceId === service.id)?.active ? 'Offered' : 'Not offered' }} at {{ location?.name }} · {{ formatStoredMoney(location!.services.find(item => item.serviceId === service.id)!.price, configuration) }}</p>
            <p v-else>Not assigned to {{ location?.name ?? 'a location' }}</p>
          </div>
          <div class="actions"><button type="button" @click="openService(service)">Edit service</button><button type="button" :disabled="!location" @click="openOffering(service.id)">Location offering & price</button></div>
        </li></ul>
        <p v-if="configuration.services.length === 0">No services yet.</p>
        <h3>Professionals</h3><button type="button" @click="openProfessional()">Add professional</button>
        <ul class="entries"><li v-for="professional in configuration.professionals" :key="professional.id">
          <div><strong>{{ professional.displayName }}</strong> · {{ professional.active ? 'Active' : 'Inactive' }}<p>{{ location?.professionals.find(item => item.professionalId === professional.id)?.active ? 'Works at this location' : 'Not active at this location' }}</p></div>
          <div class="actions"><button type="button" @click="openProfessional(professional)">Edit professional</button><button type="button" :disabled="!location" @click="openAssignment(professional.id)">Location, services & hours</button></div>
        </li></ul>
        <p v-if="configuration.professionals.length === 0">No professionals yet.</p>
      </fieldset>
      <form v-if="draft" @submit.prevent="save">
        <fieldset :disabled="state.busy">
          <legend>{{ draft.kind === 'service' ? 'Service details' : draft.kind === 'professional' ? 'Professional details' : draft.kind === 'currency' ? 'Display currency' : `Assignment at ${location?.name}` }}</legend>
          <template v-if="draft.kind === 'service'">
            <label>Name<input v-model="draft.value.name" maxlength="120" required></label>
            <label>Description<textarea v-model="draft.value.description" maxlength="1000" rows="3"></textarea></label>
            <div class="fields"><label>Appointment duration (minutes)<input v-model.number="draft.value.durationMinutes" type="number" min="1" max="1440" step="1" required></label><label>Buffer after appointment (minutes)<input v-model.number="draft.value.bufferMinutes" type="number" min="0" max="1440" step="1" required></label></div>
            <label class="check"><input v-model="draft.value.active" type="checkbox">Active catalog service</label>
            <p>Changes affect future bookings. Existing appointments retain their saved service name and price. Assigned services may be protected from deactivation.</p>
          </template>
          <template v-else-if="draft.kind === 'professional'">
            <label>Display name<input v-model="draft.value.displayName" maxlength="120" required></label>
            <label class="check"><input v-model="draft.value.active" type="checkbox">Active professional</label>
            <p>Location assignments and appointment references can prevent deactivation.</p>
          </template>
          <template v-else-if="draft.kind === 'offering'">
            <h3>{{ configuration.services.find(item => item.id === (draft?.kind === 'offering' ? draft.serviceId : ''))?.name }}</h3>
            <label class="check"><input v-model="draft.active" type="checkbox">Offer this service at {{ location?.name }}</label>
            <div class="fields"><label>Price<input v-model="draft.amount" inputmode="decimal" required placeholder="125.50"></label><label>Currency (USD, MXN…)<input v-model="draft.currency" maxlength="3" required></label></div>
            <p>Price is informational; no payment is collected. A location’s default service must stay active. Change its default under Locations before disabling that offering.</p>
          </template>
          <template v-else-if="draft.kind === 'currency'">
            <label>Default display currency<select v-model="draft.value"><option v-for="currency in DISPLAY_CURRENCIES" :key="currency" :value="currency">{{ currency }}</option></select></label>
            <p>Preview: {{ formatDisplayMoney(12550, { displayCurrency: draft.value }) }}</p>
            <p>Used for new prices and amounts without a recorded currency. Existing service prices, booked prices and provider billing retain their recorded currency. No exchange-rate conversion.</p>
          </template>
          <template v-else>
            <h3>{{ configuration.professionals.find(item => item.id === (draft?.kind === 'assignment' ? draft.value.professionalId : ''))?.displayName }}</h3>
            <label class="check"><input v-model="draft.value.active" type="checkbox">Works at {{ location?.name }}</label>
            <h4>Services this professional can perform here</h4>
            <label v-for="offering in location?.services" :key="offering.serviceId" class="check"><input v-model="draft.value.serviceIds" type="checkbox" :value="offering.serviceId">{{ configuration.services.find(item => item.id === offering.serviceId)?.name ?? offering.serviceId }}{{ offering.active ? '' : ' (offering inactive)' }}</label>
            <p v-if="!location?.services.length">Assign services to this location first.</p>
            <h4>Weekly availability</h4>
            <p>Times use {{ location?.timezone }}. An empty schedule inherits location hours. Custom hours are intersected with location hours and closures; they do not override them.</p>
            <div v-for="(hours, index) in draft.value.openingHours" :key="index" class="hours">
              <label>Day<select v-model.number="hours.dayOfWeek"><option v-for="(day, number) in days" :key="day" :value="number">{{ day }}</option></select></label>
              <label>From<input v-model="hours.startTime" type="time" required></label><label>Until<input v-model="hours.endTime" type="time" required></label>
              <button type="button" :aria-label="`Remove hours row ${index + 1}`" @click="draft.value.openingHours.splice(index, 1)">Remove</button>
            </div>
            <button type="button" @click="draft.value.openingHours.push({ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' })">Add hours</button>
            <p>Existing appointment references may prevent removing services or disabling this assignment.</p>
          </template>
          <div class="actions save"><button class="primary" :disabled="state.busy || state.conflict">{{ state.busy ? 'Saving…' : 'Save changes' }}</button><button type="button" @click="cancel">Discard draft</button></div>
        </fieldset>
      </form>
    </template>
  </section>
</template>

<style scoped>
.catalog-settings{max-width:1000px;margin:auto}.catalog-settings fieldset{border:1px solid #b9c3cd;border-radius:12px;padding:22px;margin:20px 0}.catalog-settings label{display:grid;gap:6px;margin-bottom:14px}.catalog-settings input:not([type=checkbox]),.catalog-settings select,.catalog-settings textarea{width:100%;box-sizing:border-box;padding:10px;min-width:0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.catalog-settings .check{display:flex;align-items:center}.entries{list-style:none;padding:0}.entries li{display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;padding:18px 0;border-bottom:1px solid #b9c3cd}.entries p{margin:6px 0}.actions,.hours{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.hours label{flex:1;min-width:120px}.save{margin-top:24px}.catalog-settings [role=alert]{padding:14px;background:#fff0ef;color:#7b2424;border:1px solid #cf8b83}.catalog-settings [role=status]{color:#24613c}@media(max-width:650px){.fields{grid-template-columns:1fr}}
</style>
