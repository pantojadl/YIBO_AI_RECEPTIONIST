<script setup lang="ts">
import { ref, watch } from "vue";
import AvailabilitySearch from "./AvailabilitySearch.vue";
import type { Appointment, Customer } from "../services/api";
import type { AvailabilityPreferences } from "../services/availability-search";
import { createBookingCustomer } from "../services/booking-customer";
import { useUnsavedChanges } from "../services/unsaved-changes";

const props = defineProps<{ customer?: Customer; preferences: AvailabilityPreferences }>();
const emit = defineEmits<{ booked: [appointment: Appointment]; customerSelected: [customer: Customer]; busy: [value: boolean] }>();
const customer = createBookingCustomer(props.customer), { state } = customer;
const booking = ref(false), phoneInput = ref<HTMLInputElement>();
watch(() => state.busy || booking.value, value => emit("busy", value), { flush: "sync" });
useUnsavedChanges(() => false, () => state.busy || booking.value);
async function choose() { const selected = await customer.choose(); if (selected) emit("customerSelected", selected); }
</script>

<template>
  <section aria-label="Customer for appointment" class="booking-customer">
    <h3>Customer</h3>
    <div v-if="state.selected" class="customer-selected">
      <p><strong>{{ state.selected.name || 'Customer' }}</strong><br>{{ state.selected.phone }}</p>
      <button type="button" :disabled="booking" @click="customer.clear()">Change customer</button>
    </div>
    <form v-else @submit.prevent="choose">
      <p>Use a phone number to select an existing customer. If it is new, a customer is added with the name below.</p>
      <fieldset :disabled="state.busy || booking">
        <label>Customer phone<input ref="phoneInput" v-model="state.phone" type="tel" autocomplete="off" required placeholder="+1 555 000 0000"></label>
        <label>Name for a new customer<input v-model="state.name" autocomplete="off"></label>
        <button type="submit">{{ state.busy ? 'Finding customer…' : 'Find or add customer' }}</button>
      </fieldset>
    </form>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
  </section>
  <AvailabilitySearch :customer="state.selected" :can-manage-settings="false" :initial-preferences="preferences" auto-search
    @customer-needed="phoneInput?.focus()" @booked="emit('booked', $event)" @busy="booking = $event" />
</template>

<style scoped>
.booking-customer button{min-height:44px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--blue-ink);font-weight:600}.booking-customer button:disabled{opacity:.5;cursor:not-allowed}.booking-customer button:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
.booking-customer{padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--ice);margin-bottom:24px}.booking-customer h3{margin-bottom:12px}.booking-customer fieldset{display:grid;grid-template-columns:1fr 1fr auto;gap:14px;align-items:end;border:0;padding:0;min-width:0}.booking-customer p{line-height:1.5;margin-bottom:12px}.customer-selected{display:flex;justify-content:space-between;gap:16px;align-items:center}.customer-selected p{margin:0;overflow-wrap:anywhere}.booking-customer [role=alert]{color:#7b2424;margin-top:12px}@media(max-width:700px){.booking-customer fieldset{grid-template-columns:1fr}.customer-selected{align-items:stretch;flex-direction:column}}
</style>
