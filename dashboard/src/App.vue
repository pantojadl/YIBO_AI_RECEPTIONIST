<script setup lang="ts">
import { computed, provide, nextTick, onMounted, onUnmounted, ref } from "vue";
import { api, ApiError, type Appointment, type Business, type Customer, type GoogleCalendarStatus, type Readiness } from "./services/api";
import { createAdminSession } from "./services/admin-session";
import { messages, type MessageKey } from "./i18n";
import AgentConfigurationPanel from "./components/AgentConfigurationPanel.vue";
import AgentVoiceLab from "./components/AgentVoiceLab.vue";
import AdminLogin from "./components/AdminLogin.vue";
import LocationSettings from "./components/LocationSettings.vue";
import AppointmentCalendar from "./components/AppointmentCalendar.vue";
import CalendarSettings from "./components/CalendarSettings.vue";
import CatalogSettings from "./components/CatalogSettings.vue";
import AvailabilitySearch from "./components/AvailabilitySearch.vue";
import OfficeWorkspace from "./components/OfficeWorkspace.vue";
import CustomerDirectory from "./components/CustomerDirectory.vue";
import AvailabilityBoard from "./components/AvailabilityBoard.vue";

import { createUnsavedChanges, unsavedChangesKey } from "./services/unsaved-changes";
const leaveGuard = createUnsavedChanges(message => window.confirm(message), message => window.alert(message));
provide(unsavedChangesKey, leaveGuard);

type Section = "office" | "overview" | "agent" | "customers" | "availability" | "team-availability" | "appointments" | "settings" | "catalog" | "calendars";
const section = ref<Section>("office");
const adminSession = createAdminSession();
const auth = adminSession.state;
const readOnly = computed(() => auth.principal?.roles.includes("read_only") ?? false);
const previewVisible = ref(false);
async function showVoicePreview(): Promise<void> {
  previewVisible.value = true;
  await nextTick();
  document.getElementById("voice-lab-title")?.scrollIntoView({ behavior: "smooth" });
}
const business = ref<Business>();
const apiOnline = ref(false);
const googleCalendar = ref<GoogleCalendarStatus>({ configured: false, connected: false });
const readiness = ref<Readiness>();
const globalError = ref("");
const busy = ref(false);
const customer = ref<Customer>();
const createdAppointment = ref<Appointment>();
const settingsLocationId = ref("");
leaveGuard.register({ dirty: () => false, busy: () => busy.value });

// The dashboard is intentionally English even if an older business profile has a Spanish locale.
const locale = computed(() => "en-US" as const);
const copy = computed(() => messages[locale.value]);
const navItems = computed(() => ([
  ["office", "Office schedule"], ["overview", copy.value.overview], ["agent", copy.value.agent], ["customers", copy.value.customers],
  ["availability", copy.value.availability], ["team-availability", "Team availability"], ["appointments", copy.value.appointments], ["settings", "Settings"], ["catalog", "Services & professionals"], ["calendars", "Calendar mappings"],
] as Array<[Section, string]>).filter(([candidate]) => canAccessSection(candidate)));
const t = (key: MessageKey): string => copy.value[key];

onMounted(async () => {
  window.addEventListener("beforeunload", leaveGuard.beforeUnload);
  await adminSession.restore();
  if (auth.phase === "authenticated") await loadWorkspace();
});

onUnmounted(() => { adminSession.dispose(); window.removeEventListener("beforeunload", leaveGuard.beforeUnload); });

async function loadWorkspace(): Promise<void> {
  try {
    const [health, profile, calendarStatus, readinessStatus] = await Promise.all([
      api.health(),
      api.business(),
      adminSession.can("tenant_admin") ? api.googleCalendarStatus() : Promise.resolve({ configured: false, connected: false }),
      adminSession.can("tenant_admin") ? api.readiness() : Promise.resolve(undefined),
    ]);
    apiOnline.value = health.status === "ok";
    business.value = profile;
    googleCalendar.value = calendarStatus;
    readiness.value = readinessStatus;
  } catch (error) {
    globalError.value = messageFor(error);
  }
}

async function login(credentials: { email: string; password: string }): Promise<void> {
  if (await adminSession.login(credentials)) await loadWorkspace();
}

async function logout(): Promise<void> {
  if (!leaveGuard.allowLeave()) return;
  await adminSession.logout();
  section.value = "overview";
  business.value = undefined;
  customer.value = undefined;
}

function canAccessSection(candidate: Section): boolean {
  return !["agent", "settings", "catalog", "calendars"].includes(candidate) || adminSession.can("tenant_admin");
}

function chooseSection(value: Section, locationId = ""): void {
  if (value === section.value || !canAccessSection(value) || !leaveGuard.allowLeave()) return;
  if (value === "settings") settingsLocationId.value = locationId;
  section.value = value;
  globalError.value = "";
}

async function connectGoogleCalendar(): Promise<void> {
  if (!leaveGuard.allowLeave()) return;
  await run(async () => { window.location.assign((await api.googleCalendarConnect(window.location.origin)).url); });
}

function selectDirectoryCustomer(value: Customer): void { customer.value = value; }
function availabilityBooked(value: Appointment): void { createdAppointment.value = value; section.value = "appointments"; }

async function locationSettingsSaved(): Promise<void> {
  await run(async () => { business.value = await api.business(); });
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  globalError.value = "";
  try { await action(); } catch (error) { globalError.value = messageFor(error); } finally { busy.value = false; }
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return `${t("operationFailed")} (${error.code}).`;
  return t("apiConnectionFailed");
}

function statusLabel(status: string): string {
  if (status === "CONFIRMED") return "Confirmed";
  if (status === "CANCELLED") return "Cancelled";
  if (status === "FAILED") return "Failed";
  return status === "PENDING_CONFIRMATION" ? "Pending confirmation" : status;
}
</script>

<template>
  <main v-if="auth.phase === 'loading'" class="auth-shell" aria-live="polite">
    <section class="auth-card auth-loading"><span class="brand-mark">Y</span><h1>Opening your workspace…</h1></section>
  </main>
  <AdminLogin v-else-if="auth.phase === 'anonymous'" :busy="auth.busy" :error="auth.error" @submit="login" />
  <div v-else class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">Y</span><div><strong>YIBO</strong><small>Welcome studio</small></div></div>
      <nav aria-label="Main navigation">
        <button v-for="item in navItems"
          :key="item[0]" :class="{ active: section === item[0] }" @click="chooseSection(item[0])">
          <span class="nav-dot"></span>{{ item[1] }}
        </button>
      </nav>
      <div class="sidebar-account">
        <div><strong>{{ auth.principal?.subject }}</strong><small>{{ auth.principal?.roles[0]?.replaceAll('_', ' ') }}</small></div>
        <button type="button" :disabled="auth.busy" @click="logout">Sign out</button>
      </div>
      <div class="sidebar-status"><span :class="['status-dot', { online: apiOnline }]"></span>{{ apiOnline ? t('apiConnected') : t('apiOffline') }}</div>
    </aside>

    <main>
      <header v-if="['appointments', 'availability', 'catalog', 'calendars'].includes(section)"><div><p class="eyebrow">{{ t('localEnvironment') }}</p><h1>{{ business?.name ?? 'YIBO Demo Clinic' }}</h1></div><span v-if="['catalog', 'calendars'].includes(section)" class="timezone">{{ business?.timezone ?? 'America/Merida' }}</span></header>
      <p v-if="globalError" class="alert" role="alert">{{ globalError }}</p>

      <section v-if="section === 'office'" class="view office-view"><OfficeWorkspace :read-only="readOnly" /></section>

      <section v-else-if="section === 'overview'" class="view home-view">
        <div class="home-intro">
          <div><p class="eyebrow">{{ t('localEnvironment') }}</p><h1>{{ business?.name ?? 'YIBO Demo Clinic' }}</h1><p>{{ t('homeSubtitle') }}</p></div>
          <div class="home-actions"><span :class="['pill', { success: readiness?.ready }]">{{ readiness?.ready ? t('systemReady') : 'Setup required' }}</span><button class="primary" @click="chooseSection('agent')">{{ t('testAgent') }} <span aria-hidden="true">→</span></button></div>
        </div>
        <div class="home-dashboard">
          <section class="home-snapshot" aria-labelledby="home-status-title">
            <div class="home-snapshot-heading"><div><p class="eyebrow">{{ t('overview') }}</p><h2 id="home-status-title">{{ t('operationalConfiguration') }}</h2></div><span class="timezone">{{ business?.timezone ?? 'America/Merida' }}</span></div>
            <div class="home-metrics">
              <article><span>{{ t('services') }}</span><strong>{{ business?.services.length ?? '—' }}</strong><small>{{ t('configured') }}</small></article>
              <article><span>{{ t('professionals') }}</span><strong>{{ business?.employees.length ?? '—' }}</strong><small>{{ t('active') }}</small></article>
              <article><span>{{ t('timezone') }}</span><strong class="metric-text">{{ business?.timezone ?? '—' }}</strong><small>{{ t('sourceOfTruth') }}</small></article>
            </div>
          </section>
          <article class="home-calendar">
            <div class="calendar-mark" aria-hidden="true"><span></span><b>31</b></div>
            <div><p class="eyebrow">Google Calendar</p><h3>{{ googleCalendar.connected ? 'Connected' : googleCalendar.configured ? t('calendarSetup') : t('calendarMissing') }}</h3><p v-if="googleCalendar.connected">{{ t('calendarReadyHelp') }}</p><p v-else-if="googleCalendar.configured">{{ t('calendarSetupHelp') }}</p><p v-else>{{ t('calendarMissingHelp') }}</p></div>
            <span v-if="googleCalendar.connected" class="pill success">Connected</span><button v-else-if="googleCalendar.configured" class="primary" :disabled="busy" @click="connectGoogleCalendar">Reconnect Google Calendar</button><span v-else class="pill">{{ t('notConfigured') }}</span>
          </article>
          <article v-if="readiness" class="home-calendar"><div><p class="eyebrow">Go-live readiness</p><h3>{{ readiness.ready ? 'Ready for pilot checks' : 'Setup required' }}</h3><p v-if="readiness.blockers.length">{{ readiness.blockers.join(' · ') }}</p><p v-else>Core providers and location relationships are configured.</p><ul><li v-for="item in readiness.locations" :key="item.id">{{ item.name }}: {{ item.ready ? 'Ready' : item.issues.join(', ') }}</li></ul></div><span :class="['pill', { success: readiness.ready }]">{{ readiness.ready ? 'Ready' : 'Needs setup' }}</span></article>
        </div>
        <div class="two-column home-details">
          <article class="panel"><h3>{{ t('availableServices') }}</h3><div v-for="service in business?.services" :key="service.id" class="list-row"><div><strong>{{ service.name }}</strong><small>{{ service.id }}</small></div><span>{{ service.durationMinutes }} min</span></div></article>
          <article class="panel"><h3>{{ t('businessHours') }}</h3><div v-for="hours in business?.openingHours" :key="hours.dayOfWeek" class="list-row"><strong>{{ copy.days[hours.dayOfWeek] }}</strong><span>{{ hours.startTime }} — {{ hours.endTime }}</span></div></article>
        </div>
      </section>

      <section v-else-if="section === 'agent'" class="view agent-view">
        <AgentVoiceLab v-if="previewVisible" :expected-tenant-id="auth.principal?.tenantId" />
        <AgentConfigurationPanel :locale="locale" @preview="showVoicePreview" />
      </section>

      <section v-else-if="section === 'customers'" class="view">
        <CustomerDirectory :read-only="readOnly" :timezone="business?.timezone" @selected="selectDirectoryCustomer" />
      </section>

      <section v-else-if="section === 'availability'" class="view">
        <AvailabilitySearch :customer="customer" :read-only="readOnly" :can-manage-settings="adminSession.can('tenant_admin')" @booked="availabilityBooked" @customer-needed="chooseSection('customers')" @settings="locationId => chooseSection('settings', locationId)" />
      </section>

      <section v-else-if="section === 'team-availability'" class="view">
        <AvailabilityBoard :customer="customer" :read-only="readOnly" @booked="availabilityBooked" />
      </section>

      <section v-else-if="section === 'appointments'" class="view">
        <AppointmentCalendar :read-only="readOnly" :customer="customer" :initial-appointment="createdAppointment" @customer-selected="customer = $event" />
      </section>

      <section v-else-if="section === 'calendars'" class="view">
        <CalendarSettings @saved="locationSettingsSaved" />
      </section>

      <section v-else-if="section === 'catalog'" class="view">
        <CatalogSettings @saved="locationSettingsSaved" />
      </section>

      <section v-else-if="section === 'settings'" class="view">
        <LocationSettings :initial-location-id="settingsLocationId" @saved="locationSettingsSaved" />
      </section>
    </main>
  </div>
</template>
