<script setup lang="ts">
import type { LocationDefinition } from "../../../src/modules/business/domain/multi-location-business.js";
import { appointmentRules, setLocationActionBlocked, setLocationAgentOverride } from "../services/business-agent-controls";

defineProps<{ location: LocationDefinition }>();
</script>

<template>
  <section aria-labelledby="location-agent-rules-title">
    <h3 id="location-agent-rules-title">AI rules at this location</h3>
    <p>Leave a rule on “Use business setting” to inherit Agent settings. Restrictions apply to both Phone and Voice Lab on the next conversation. Business and channel restrictions always take priority.</p>
    <div class="rule-fields">
      <label>Service price disclosure<select :value="location.agentOverrides?.allowPriceDisclosure === false ? 'blocked' : ''" @change="setLocationAgentOverride(location, 'allowPriceDisclosure', ($event.target as HTMLSelectElement).value === 'blocked' ? false : undefined)"><option value="">Use business setting</option><option value="blocked">Do not disclose prices here</option></select></label>
      <label v-for="rule in appointmentRules" :key="rule.tool">{{ rule.label }}<select :value="location.agentOverrides?.disabledTools?.includes(rule.tool) ? 'blocked' : ''" @change="setLocationActionBlocked(location, rule.tool, ($event.target as HTMLSelectElement).value === 'blocked')"><option value="">Use business setting</option><option value="blocked">Block at this location</option></select></label>
      <label>Phone number readback<select :value="location.agentOverrides?.phoneReadback ?? ''" @change="setLocationAgentOverride(location, 'phoneReadback', ($event.target as HTMLSelectElement).value as 'natural_grouped' | 'digit_by_digit' || undefined)"><option value="">Use business setting</option><option value="natural_grouped">Natural / grouped</option><option value="digit_by_digit">Digit by digit</option></select></label>
      <label>Agent language override<input :value="location.agentOverrides?.locale ?? ''" placeholder="Use business setting (for example, en-US)" @input="setLocationAgentOverride(location, 'locale', ($event.target as HTMLInputElement).value || undefined)"><small>Optional language tag, such as en-US or es-MX. This is the agent’s response language, separate from this location’s date/currency locale. Custom greeting and silence messages keep their saved text.</small></label>
    </div>
    <p>Save with the other location settings below. Availability suggestions remain in the section above.</p>
  </section>
</template>

<style scoped>
h3{margin-top:28px}p,small{font-size:.9rem;line-height:1.5}.rule-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}label{display:grid;gap:6px}input,select{width:100%;box-sizing:border-box;padding:10px;min-width:0}@media(max-width:650px){.rule-fields{grid-template-columns:1fr}}
</style>
