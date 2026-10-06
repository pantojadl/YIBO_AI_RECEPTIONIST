import { computed, reactive } from "vue";
import type { EditableBusinessConfiguration, VersionedBusinessConfiguration, LocationDefinition } from "../../../src/modules/business/index.js";
import { api, ApiError } from "./api.js";
import { DEFAULT_AVAILABILITY_SUGGESTIONS, resolvedAiCapabilities, type AvailabilitySuggestionsPolicy } from "../../../src/modules/business/domain/multi-location-business.js";

export function updateAvailabilitySuggestions(location: LocationDefinition, patch: Partial<AvailabilitySuggestionsPolicy>): void {
  location.policies.availabilitySuggestions = { ...(location.policies.availabilitySuggestions ?? DEFAULT_AVAILABILITY_SUGGESTIONS), ...patch };
}

export function initializeLocationControls(location: LocationDefinition): void {
  location.policies.sameDayBooking ??= true;
  location.policies.cancellationAllowed ??= true;
  location.policies.reschedulingAllowed ??= true;
  location.policies.staffOverrideAllowed ??= false;
  location.aiCapabilities = resolvedAiCapabilities(location);
}

export function createLocationEditor(client = api) {
  const state = reactive({
    draft: undefined as EditableBusinessConfiguration | undefined,
    baseline: "", version: 0, busy: false, error: "", conflict: false, saved: false,
  });
  const accept = (document: VersionedBusinessConfiguration) => {
    state.draft = JSON.parse(JSON.stringify(document.configuration));
    // Display optional legacy defaults before capturing the clean editor baseline.
    state.draft?.locations.forEach(initializeLocationControls);
    state.baseline = JSON.stringify(state.draft);
    state.version = document.version;
    state.conflict = false;
  };
  async function load() {
    if (state.busy) return;
    state.busy = true; state.error = ""; state.saved = false;
    try { accept(await client.businessConfiguration()); }
    catch { state.error = "Unable to load location settings. Check your access and try again."; }
    finally { state.busy = false; }
  }
  async function save() {
    if (!state.draft || state.busy || state.conflict) return false;
    state.busy = true; state.error = ""; state.saved = false;
    try {
      // Snapshot the form; preserve untouched catalogs, assignments and routing.
      accept(await client.updateBusinessConfiguration(JSON.parse(JSON.stringify(state.draft)), state.version));
      state.saved = true;
      return true;
    } catch (error) {
      state.conflict = error instanceof ApiError && error.code === "CONFIGURATION_VERSION_CONFLICT";
      state.error = state.conflict
        ? "Settings changed on the server. Your edits are still here. Copy any edits you need, then discard this draft and load the latest settings before saving."
        : error instanceof ApiError && error.status === 403
          ? "Only a tenant administrator can save location settings."
          : "Location settings were not saved. Check required fields, unique phone numbers, time zones, hours, closure dates, policies and AI rules, then try again.";
      return false;
    } finally { state.busy = false; }
  }
  return { state, load, save, dirty: computed(() => Boolean(state.draft) && JSON.stringify(state.draft) !== state.baseline), canSave: computed(() => Boolean(state.draft) && !state.busy && !state.conflict) };
}

export function newLocation(source: LocationDefinition, id: string): LocationDefinition {
  return {
    id, name: "New location", active: false,
    address: { line1: "", city: "", countryCode: source.address.countryCode },
    timezone: source.timezone, locale: source.locale, calledNumbers: [], openingHours: [], closures: [],
    policies: JSON.parse(JSON.stringify(source.policies)),
    // Keep a valid default service without copying professional/calendar routes.
    services: JSON.parse(JSON.stringify(source.services)), professionals: [],
  };
}
