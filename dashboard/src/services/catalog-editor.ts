import { reactive } from "vue";
import type { VersionedBusinessConfiguration, TenantServiceDefinition, ProfessionalDefinition, LocationServiceAssignment, LocationProfessionalAssignment, Money } from "../../../src/modules/business/index.js";
import { api, ApiError } from "./api.js";

export const copyCatalogValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function priceText(price: Money): string {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: price.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const value = String(price.amountMinor).padStart(digits + 1, "0");
  return digits === 0 ? value : `${value.slice(0, -digits)}.${value.slice(-digits)}`;
}
export function parsePrice(amount: string, currencyInput: string): Money {
  const currency = currencyInput.trim().toUpperCase();
  if (!Intl.supportedValuesOf("currency").includes(currency)) throw new Error("Choose an ISO currency code, such as USD or MXN.");
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match || (match[2]?.length ?? 0) > digits) throw new Error(`Enter a non-negative price with at most ${digits} decimal places.`);
  const amountMinor = Number(match[1] + (match[2] ?? "").padEnd(digits, "0"));
  if (!Number.isSafeInteger(amountMinor)) throw new Error("Price is too large.");
  return { amountMinor, currency };
}

export function createCatalogEditor(client = api) {
  const state = reactive({ document: undefined as VersionedBusinessConfiguration | undefined, busy: false, conflict: false, error: "", saved: false });
  async function load() {
    if (state.busy) return false;
    state.busy = true; state.error = "";
    try { state.document = await client.businessConfiguration(); state.conflict = false; state.saved = false; return true; }
    catch { state.error = "Unable to load catalogs. Check your administrator access and try again."; return false; }
    finally { state.busy = false; }
  }
  async function mutate(operation: (document: VersionedBusinessConfiguration) => Promise<void>) {
    if (!state.document || state.busy || state.conflict) return false;
    state.busy = true; state.error = ""; state.saved = false;
    const document = copyCatalogValue(state.document);
    try { await operation(document); state.document = document; state.saved = true; return true; }
    catch (error) {
      state.conflict = error instanceof ApiError && error.code === "CONFIGURATION_VERSION_CONFLICT";
      state.error = state.conflict ? "Settings changed elsewhere. Your draft is retained. Copy any edits you need, then discard the draft and load the latest settings."
        : error instanceof ApiError ? ({
          SERVICE_IN_USE: "This service is still assigned or in use. Keep the catalog entry active; manage its location offerings separately.",
          PROFESSIONAL_IN_USE: "This professional or assignment is in use. Existing appointment references prevent this change.",
          ROLE_REQUIRED: "Only tenant administrators can edit catalogs.",
        }[error.code] ?? `Not saved (${error.code}). Check the entered fields and location assignments.`)
        : error instanceof Error ? error.message : "Settings were not saved.";
      return false;
    } finally { state.busy = false; }
  }
  const saveDisplayCurrency = (currency: "USD" | "MXN" | "EUR") => mutate(async (document) => {
    document.configuration.displayCurrency = currency;
    Object.assign(document, await client.updateBusinessConfiguration(document.configuration, document.version));
  });
  const saveService = (service: TenantServiceDefinition, isNew: boolean) => mutate(async (document) => {
    const { id, ...fields } = copyCatalogValue(service);
    const result = isNew ? await client.createService({ id, ...fields }, document.version) : await client.updateService(id, fields, document.version);
    document.version = result.version;
    document.configuration.services = isNew ? [...document.configuration.services, result.service] : document.configuration.services.map(item => item.id === id ? result.service : item);
  });
  const saveProfessional = (professional: ProfessionalDefinition, isNew: boolean) => mutate(async (document) => {
    const { id, ...fields } = copyCatalogValue(professional);
    const result = isNew ? await client.createProfessional({ id, ...fields }, document.version) : await client.updateProfessional(id, fields, document.version);
    document.version = result.version;
    document.configuration.professionals = isNew ? [...document.configuration.professionals, result.professional] : document.configuration.professionals.map(item => item.id === id ? result.professional : item);
  });
  const saveOffering = (locationId: string, serviceId: string, active: boolean, amount: string, currency: string) => mutate(async (document) => {
    const location = document.configuration.locations.find(item => item.id === locationId);
    if (!location) throw new Error("Select a location.");
    const assignment: LocationServiceAssignment = { serviceId, active, price: parsePrice(amount, currency) };
    const existing = location.services.some(item => item.serviceId === serviceId);
    location.services = existing ? location.services.map(item => item.serviceId === serviceId ? assignment : item) : [...location.services, assignment];
    // This is the existing API for service offerings/prices. Only that assignment changes.
    const result = await client.updateBusinessConfiguration(document.configuration, document.version);
    Object.assign(document, result);
  });
  const saveAssignment = (locationId: string, assignment: LocationProfessionalAssignment) => mutate(async (document) => {
    const location = document.configuration.locations.find(item => item.id === locationId);
    if (!location) throw new Error("Select a location.");
    const { professionalId, calendarId: _untrustedRoute, ...fields } = copyCatalogValue(assignment);
    const existing = location.professionals.find(item => item.professionalId === professionalId);
    // UI-006 cannot edit calendar routing, even if supplied by a stale form.
    const result = await client.setProfessionalAssignment(locationId, professionalId, { ...fields, ...(existing?.calendarId ? { calendarId: existing.calendarId } : {}) }, document.version);
    document.version = result.version;
    location.professionals = existing ? location.professionals.map(item => item.professionalId === professionalId ? result.assignment : item) : [...location.professionals, result.assignment];
  });
  return { state, load, saveDisplayCurrency, saveService, saveProfessional, saveOffering, saveAssignment };
}
