<script setup lang="ts">
import { useUnsavedChanges } from "../services/unsaved-changes";
import { computed, onMounted, ref } from "vue";
import {
  api,
  ApiError,
  type AgentConfiguration,
  type AgentConfigurationPayload,
  type AgentToolName,
  type RealtimeModelCapability,
  type TurnDetectionMode,
} from "../services/api";
import { phoneTurnDetectionModes, validateAgentCapabilityFields } from "../services/agent-capability-controls";
import { prioritizeCollectionField, setConfirmationRequired, setToolEnabled } from "../services/agent-policy-controls";
import { appointmentRules } from "../services/business-agent-controls";

defineProps<{ locale: "es-MX" | "en-US" }>();
const emit = defineEmits<{ preview: [] }>();

type Step = "identity" | "conversation" | "silence" | "abilities" | "confirmations" | "limits" | "instructions";
type VadPreset = "auto" | "fast" | "balanced" | "patient" | "custom";

const steps: Array<{ id: Step; number: string; label: string }> = [
  { id: "identity", number: "01", label: "Identity" },
  { id: "conversation", number: "02", label: "Turn & audio" },
  { id: "silence", number: "03", label: "Silence" },
  { id: "abilities", number: "04", label: "Business rules" },
  { id: "confirmations", number: "05", label: "Confirm" },
  { id: "limits", number: "06", label: "Limits" },
  { id: "instructions", number: "07", label: "Instructions" },
];
const locales = [
  ["es-MX", "Español · México"], ["es-US", "Español · Estados Unidos"],
  ["es-ES", "Español · España"], ["en-US", "English · United States"],
  ["en-GB", "English · United Kingdom"], ["pt-BR", "Português · Brasil"],
];
type ServerVad = Extract<AgentConfiguration["audio"]["turnDetection"], { type: "server_vad" }>;
const vadPresets: Record<Exclude<VadPreset, "custom">, ServerVad> = {
  auto: { type: "server_vad", createResponse: true, interruptResponse: true, silenceDurationMs: 800 },
  fast: { type: "server_vad", createResponse: true, interruptResponse: true, threshold: 0.58, prefixPaddingMs: 240, silenceDurationMs: 380 },
  balanced: { type: "server_vad", createResponse: true, interruptResponse: true, threshold: 0.5, prefixPaddingMs: 300, silenceDurationMs: 600 },
  patient: { type: "server_vad", createResponse: true, interruptResponse: true, threshold: 0.44, prefixPaddingMs: 420, silenceDurationMs: 1000 },
};
const baseline = ref("");
const revision = ref("");
const conflict = ref(false);
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const apiKeyConfigured = ref(false);
const configuration = ref<AgentConfiguration>();
const recommended = ref<AgentConfiguration>();
const availableTools = ref<AgentConfigurationPayload["availableTools"]>([]);
const modelCapabilities = ref<RealtimeModelCapability[]>([]);
const step = ref<Step>("identity");
useUnsavedChanges(() => Boolean(configuration.value) && JSON.stringify(configuration.value) !== baseline.value, () => saving.value || loading.value);

const currentStep = computed(() => steps.findIndex((candidate) => candidate.id === step.value));
const selectedCapability = computed(() => modelCapabilities.value.find(({ id }) => id === configuration.value?.conversation.model));
const models = computed(() => modelCapabilities.value);
const voices = computed(() => selectedCapability.value?.voices ?? []);
const reasoningEfforts = computed(() => selectedCapability.value?.controls.reasoningEfforts ?? []);
const turnDetectionModes = computed(() => phoneTurnDetectionModes(selectedCapability.value));
const outputLimits = computed(() => selectedCapability.value?.limits.responseOutputTokens ?? { minimum: 1, maximum: 4096, uiMinimum: 64, step: 64 });
const fieldErrors = computed<Record<string, string>>(() => validateAgentCapabilityFields(configuration.value, selectedCapability.value));
const hasFieldErrors = computed(() => Object.keys(fieldErrors.value).length > 0);
const vadPreset = computed<VadPreset>(() => {
  const value = configuration.value?.audio.turnDetection;
  if (!value || value.type !== "server_vad") return "custom";
  for (const [key, preset] of Object.entries(vadPresets)) {
    if (sameVad(value, preset)) return key as Exclude<VadPreset, "custom">;
  }
  return "custom";
});
const activeToolCount = computed(() => configuration.value?.enabledTools.length ?? 0);
const mutableTools = computed(() => availableTools.value.filter(({ kind }) => kind === "mutate"));
const enabledToolDescriptors = computed(() => availableTools.value.filter(({ name }) => configuration.value?.enabledTools.includes(name)));
const otherTools = computed(() => availableTools.value.filter(({ name }) => !appointmentRules.some(rule => rule.tool === name)));
const canAutoTransfer = computed(() => configuration.value?.enabledTools.includes("transfer_to_human")
  && Object.values(configuration.value.toolPolicies.channels).every(({ enabledTools }) => enabledTools.includes("transfer_to_human")));

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const payload = await api.agentConfiguration();
    recommended.value = clone(payload.recommended);
    configuration.value = clone(payload.current ?? payload.recommended);
    baseline.value = JSON.stringify(configuration.value); revision.value = payload.revision; conflict.value = false; saved.value = false;
    availableTools.value = payload.availableTools;
    modelCapabilities.value = payload.modelCapabilities;
    apiKeyConfigured.value = payload.secrets.apiKeyConfigured;
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

function selectStep(next: Step): void { step.value = next; }
function move(offset: number): void {
  const next = steps[Math.max(0, Math.min(steps.length - 1, currentStep.value + offset))];
  if (next) step.value = next.id;
}

function applyVad(preset: Exclude<VadPreset, "custom">): void {
  if (!configuration.value) return;
  configuration.value.audio.turnDetection = { ...vadPresets[preset] };
}

function selectModel(): void {
  if (!configuration.value || !selectedCapability.value) return;
  if (!selectedCapability.value.voices.includes(configuration.value.audio.voice)) {
    configuration.value.audio.voice = selectedCapability.value.voices[0] ?? "";
  }
  if (!selectedCapability.value.controls.reasoningEfforts.includes(configuration.value.conversation.reasoningEffort)) {
    configuration.value.conversation.reasoningEffort = selectedCapability.value.controls.reasoningEfforts[0] ?? "minimal";
  }
  if (configuration.value.audio.turnDetection.type === "manual"
    || !turnDetectionModes.value.includes(configuration.value.audio.turnDetection.type)) {
    setTurnDetection("server_vad");
  }
}

function setTurnDetection(mode: TurnDetectionMode): void {
  if (!configuration.value) return;
  configuration.value.audio.turnDetection = mode === "semantic_vad"
    ? { type: "semantic_vad", eagerness: "auto", createResponse: true, interruptResponse: true }
    : mode === "manual" ? { type: "manual" } : { ...vadPresets.auto };
}

function changeTurnDetection(event: Event): void {
  setTurnDetection((event.target as HTMLSelectElement).value as TurnDetectionMode);
}

function toggleTool(name: AgentToolName): void {
  if (!configuration.value) return;
  const active = configuration.value.enabledTools.includes(name);
  const kind = availableTools.value.find((tool) => tool.name === name)?.kind ?? "external";
  setToolEnabled(configuration.value, name, kind, !active);
}

function channelAllows(name: AgentToolName, channel: "phone" | "voice_lab"): boolean {
  const policy = configuration.value?.toolPolicies.channels[channel];
  return Boolean(configuration.value?.enabledTools.includes(name) && policy?.toolChoice !== "none" && policy?.enabledTools.includes(name));
}

function restoreRecommended(): void {
  if (JSON.stringify(configuration.value) !== baseline.value && !window.confirm("Replace your unsaved edits with the recommended settings?")) return;
  if (recommended.value) configuration.value = clone(recommended.value);
  saved.value = false;
}

async function save(): Promise<void> {
  if (!configuration.value || hasFieldErrors.value || saving.value || conflict.value) return;
  saving.value = true;
  saved.value = false;
  error.value = "";
  try {
    const result = await api.updateAgentConfiguration(configuration.value, revision.value);
    configuration.value = clone(result.configuration);
    baseline.value = JSON.stringify(configuration.value); revision.value = result.revision;
    saved.value = true;
  } catch (caught) {
    conflict.value = caught instanceof ApiError && caught.code === "CONFIGURATION_VERSION_CONFLICT";
    error.value = conflict.value ? "Settings changed elsewhere. Your draft is retained. Copy any edits you need, then discard the draft and reload." : errorMessage(caught);
  } finally {
    saving.value = false;
  }
}

function sameVad(
  left: ServerVad,
  right: ServerVad,
): boolean {
  return left.threshold === right.threshold
    && left.prefixPaddingMs === right.prefixPaddingMs
    && left.silenceDurationMs === right.silenceDurationMs;
}

function toggleConfirmation(name: AgentToolName): void {
  if (!configuration.value) return;
  const values = configuration.value.toolPolicies.confirmations.requiredFor;
  setConfirmationRequired(configuration.value, name, !values.includes(name));
}

function channelCanParallel(channel: "phone" | "voice_lab"): boolean {
  if (!selectedCapability.value?.controls.parallelToolCalls || !configuration.value || channel === "voice_lab") return false;
  return configuration.value.toolPolicies.channels[channel].enabledTools.every((name) =>
    availableTools.value.find((tool) => tool.name === name)?.kind === "consult");
}

function changeGreetingMode(event: Event): void {
  if (!configuration.value) return;
  configuration.value.behavior.greeting = (event.target as HTMLSelectElement).value === "automatic"
    ? { mode: "automatic", message: defaultGreeting(configuration.value.identity.locale) }
    : { mode: "wait_for_caller" };
}

function defaultGreeting(locale: string): string {
  if (locale.toLowerCase().startsWith("es")) return "Hola, gracias por llamar a YIBO. ¿En qué puedo ayudarle?";
  if (locale.toLowerCase().startsWith("pt")) return "Olá, agradecemos por ligar para a YIBO. Como posso ajudar?";
  return "Hello, thank you for calling YIBO. How may I help you?";
}

function changeFirstCollectionField(event: Event): void {
  if (!configuration.value) return;
  const selected = (event.target as HTMLSelectElement).value as AgentConfiguration["behavior"]["dataCollectionOrder"][number];
  prioritizeCollectionField(configuration.value, selected);
}

function clone(value: AgentConfiguration): AgentConfiguration { return JSON.parse(JSON.stringify(value)); }
function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return `Could not save the configuration (${caught.code}).`;
  return caught instanceof Error ? caught.message : "Could not load the configuration.";
}
</script>

<template>
  <section class="agent-config agent-config-v2" aria-labelledby="agent-config-title">
    <div class="config-intro">
      <div>
        <p class="config-kicker">02 · AGENT SETTINGS</p>
        <h2 id="agent-config-title">Fine-tune how YIBO talks.</h2>
        <p>Listen first, change one thing, then test again. Settings are saved for this business and apply to the next conversation.</p>
      </div>
      <div :class="['connection-chip', { ready: apiKeyConfigured }]">
        <i></i>{{ apiKeyConfigured ? "API ready" : "API key needed" }}
      </div>
    </div>

    <div v-if="loading" class="config-state"><i></i>Preparing settings…</div>
    <div v-else-if="!configuration" class="config-state error-state">{{ error }}</div>

    <form v-else @submit.prevent="save">
      <fieldset :disabled="saving" style="border:0;padding:0;margin:0;min-width:0">
      <nav class="config-steps" aria-label="Configuration steps">
        <button v-for="(item, index) in steps" :key="item.id" type="button"
          :class="{ active: step === item.id, complete: index < currentStep }" @click="selectStep(item.id)">
          <small>{{ item.number }}</small><span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="config-layout">
        <div class="config-stage">
          <section v-if="step === 'identity'" class="step-panel">
            <div class="step-heading"><span>01</span><div><h3>Conversation personality</h3><p>Choose the model, voice, and language callers will hear.</p></div></div>
            <div class="field-grid">
              <label>Conversation model<select v-model="configuration.conversation.model" @change="selectModel"><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }} — {{ model.badge }}</option></select><small>{{ selectedCapability?.description }}</small><em v-if="fieldErrors.model" class="field-error">{{ fieldErrors.model }}</em></label>
              <label>YIBO voice<select v-model="configuration.audio.voice"><option v-for="voice in voices" :key="voice" :value="voice">{{ voice[0]?.toUpperCase() }}{{ voice.slice(1) }}</option></select><small>Only voices supported by this model are shown.</small><em v-if="fieldErrors.voice" class="field-error">{{ fieldErrors.voice }}</em></label>
              <label>Language and region<select v-model="configuration.identity.locale"><option v-for="candidate in locales" :key="candidate[0]" :value="candidate[0]">{{ candidate[1] }}</option></select><small>Adjusts pronunciation, vocabulary, dates, and times.</small></label>
              <label>Reasoning<select v-model="configuration.conversation.reasoningEffort"><option v-for="effort in reasoningEfforts" :key="effort" :value="effort">{{ effort }}</option></select><small>Options come from the selected model.</small><em v-if="fieldErrors.reasoning" class="field-error">{{ fieldErrors.reasoning }}</em></label>
            </div>
            <label class="token-control"><span>Maximum response length <output>{{ configuration.conversation.maxOutputTokens }} tokens</output></span><input v-model.number="configuration.conversation.maxOutputTokens" type="range" :min="outputLimits.uiMinimum" :max="outputLimits.maximum" :step="outputLimits.step"><small>This is a ceiling, not a target. Range and step come from the model registry.</small><em v-if="fieldErrors.maxOutputTokens" class="field-error">{{ fieldErrors.maxOutputTokens }}</em></label>
            <div class="field-grid behavior-fields">
              <label>Brevity<select v-model="configuration.behavior.responseStyle.brevity"><option value="brief">Brief</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
              <label>Tone<select v-model="configuration.behavior.responseStyle.tone"><option value="warm">Warm</option><option value="professional">Professional</option><option value="direct">Direct</option></select></label>
              <label>Speaking pace<select v-model="configuration.behavior.responseStyle.pace"><option value="slow">Slow</option><option value="balanced">Balanced</option><option value="fast">Fast</option></select></label>
              <label>Options per offer<input v-model.number="configuration.behavior.slotOffering.maximumOptions" type="number" min="1" max="5"><small>Maximum verified slots spoken at once.</small></label>
            </div>
          </section>

          <section v-else-if="step === 'conversation'" class="step-panel">
            <div class="step-heading"><span>02</span><div><h3>Conversation pacing</h3><p>Control when YIBO understands that you have finished speaking.</p></div></div>
            <div class="field-grid compact-fields">
              <label>Turn detection<select :value="configuration.audio.turnDetection.type" @change="changeTurnDetection"><option v-for="mode in turnDetectionModes" :key="mode" :value="mode">{{ mode === 'server_vad' ? 'Server VAD' : 'Semantic VAD' }}</option></select><small>Modes unsupported by the model or phone channel are hidden.</small><em v-if="fieldErrors.turnDetection" class="field-error">{{ fieldErrors.turnDetection }}</em></label>
              <label>Noise reduction<select v-model="configuration.audio.noiseReduction"><option v-for="mode in selectedCapability?.controls.noiseReductionModes ?? []" :key="mode" :value="mode">{{ mode.replace('_', ' ') }}</option></select><small>Uses only modes declared by the selected model.</small></label>
            </div>
            <div v-if="configuration.audio.turnDetection.type === 'server_vad'" class="preset-grid">
              <button v-for="preset in (['auto','fast','balanced','patient'] as const)" :key="preset" type="button" :class="{ selected: vadPreset === preset }" @click="applyVad(preset)"><i>{{ preset === 'auto' ? '✦' : preset === 'fast' ? '⚡' : preset === 'balanced' ? '◉' : '◌' }}</i><strong>{{ {auto:'Automatic',fast:'Fast',balanced:'Balanced',patient:'Patient'}[preset] }}</strong><small>{{ preset === 'auto' ? 'Uses provider-managed values.' : preset === 'fast' ? 'Responds quickly in quiet environments.' : preset === 'balanced' ? 'A good starting point for a phone receptionist.' : 'Allows longer pauses before responding.' }}</small></button>
            </div>
            <details v-if="configuration.audio.turnDetection.type === 'server_vad'" class="advanced"><summary>Advanced settings <span>{{ vadPreset === 'custom' ? 'Custom' : 'Optional' }}</span></summary><p>Change these only after listening to real conversations.</p><div class="advanced-grid">
              <label>Sensitivity <output>{{ configuration.audio.turnDetection.threshold ?? 0.5 }}</output><input v-model.number="configuration.audio.turnDetection.threshold" type="range" :min="selectedCapability?.controls.serverVad.threshold.minimum" :max="selectedCapability?.controls.serverVad.threshold.maximum" step="0.01"><em v-if="fieldErrors.threshold" class="field-error">{{ fieldErrors.threshold }}</em></label>
              <label>Audio before speech <output>{{ configuration.audio.turnDetection.prefixPaddingMs ?? 300 }} ms</output><input v-model.number="configuration.audio.turnDetection.prefixPaddingMs" type="range" :min="selectedCapability?.controls.serverVad.prefixPaddingMs.minimum" :max="selectedCapability?.controls.serverVad.prefixPaddingMs.maximum" step="20"><em v-if="fieldErrors.prefixPaddingMs" class="field-error">{{ fieldErrors.prefixPaddingMs }}</em></label>
              <label>End-of-turn silence <output>{{ configuration.audio.turnDetection.silenceDurationMs ?? 600 }} ms</output><input v-model.number="configuration.audio.turnDetection.silenceDurationMs" type="range" :min="selectedCapability?.controls.serverVad.silenceDurationMs.minimum" :max="selectedCapability?.controls.serverVad.silenceDurationMs.maximum" step="50"><em v-if="fieldErrors.silenceDurationMs" class="field-error">{{ fieldErrors.silenceDurationMs }}</em></label>
            </div></details>
            <label v-else-if="configuration.audio.turnDetection.type === 'semantic_vad'" class="token-control">Semantic eagerness<select v-model="configuration.audio.turnDetection.eagerness"><option v-for="value in selectedCapability?.controls.semanticVadEagerness ?? []" :key="value" :value="value">{{ value }}</option></select><small>Controls how readily the model decides that the caller finished speaking.</small></label>
          </section>

          <section v-else-if="step === 'silence'" class="step-panel">
            <div class="step-heading"><span>03</span><div><h3>Greeting and silence</h3><p>Control who speaks first and how YIBO checks whether the caller is still present.</p></div></div>
            <div class="field-grid">
              <label>First turn<select :value="configuration.behavior.greeting.mode" @change="changeGreetingMode"><option value="wait_for_caller">Wait for caller</option><option value="automatic">Automatic greeting</option></select><small>Phone calls can begin silently or with a configured greeting.</small></label>
              <label>Silence prompts<input v-model.number="configuration.behavior.silence.maxPrompts" type="number" min="0" max="3"><small>Maximum reminders before waiting silently.</small></label>
            </div>
            <label v-if="configuration.behavior.greeting.mode === 'automatic'" class="prompt-field compact-prompt">Greeting<input v-model="configuration.behavior.greeting.message" maxlength="500"></label>
            <label class="prompt-field compact-prompt">Message after silence<input v-model="configuration.behavior.silence.message" maxlength="500"></label>
            <div class="field-grid behavior-fields">
              <label>Slot strategy<select v-model="configuration.behavior.slotOffering.strategy"><option value="earliest_first">Earliest first</option><option value="spread_across_day">Spread across day</option><option value="match_requested_time">Closest to requested time</option></select></label>
              <label>Phone readback<select v-model="configuration.behavior.phoneReadback"><option value="natural_grouped">Natural / grouped</option><option value="digit_by_digit">Digit by digit</option></select><small>Presentation only; stored phone numbers do not change.</small></label>
              <label>Collection order<small>{{ configuration.behavior.dataCollectionOrder.join(' → ') }}</small><select :value="configuration.behavior.dataCollectionOrder[0]" @change="changeFirstCollectionField"><option value="full_name">Full name first</option><option value="phone_number">Phone first</option><option value="service">Service first</option></select><small>The remaining fields keep their relative order.</small></label>
            </div>
          </section>

          <section v-else-if="step === 'abilities'" class="step-panel">
            <div class="step-heading"><span>04</span><div><h3>Business rules</h3><p>Choose what YIBO may tell callers and do for them. Saved rules apply to new conversations at every location.</p></div></div>
            <div class="field-grid business-rules">
              <label class="policy-card"><span class="check-row"><input v-model="configuration.behavior.allowPriceDisclosure" type="checkbox">Tell callers service prices</span><small>When off, YIBO refers pricing questions to staff. Prices stay visible to your office and remain on appointments.</small></label>
              <label v-for="rule in appointmentRules" :key="rule.tool" class="policy-card"><span class="check-row"><input type="checkbox" :checked="configuration.enabledTools.includes(rule.tool)" @change="toggleTool(rule.tool)">{{ rule.label }}</span><small>Phone: {{ channelAllows(rule.tool, 'phone') ? 'allowed' : 'blocked' }} · Voice Lab: {{ channelAllows(rule.tool, 'voice_lab') ? 'allowed' : 'blocked' }}</small></label>
            </div>
            <p class="security-note">Locations can add restrictions in Settings → Locations → AI rules. A location cannot re-enable an action blocked here or by its channel. Booking still requires verified availability and caller agreement.</p>
            <p>For language and options per offer, use <button type="button" @click="selectStep('identity')">Identity</button>. For phone readback, use <button type="button" @click="selectStep('silence')">Silence</button>. Alternatives outside a requested time are controlled in Settings → Locations → Availability suggestions.</p>
            <h4>Other capabilities</h4>
            <div class="tool-grid"><button v-for="tool in otherTools" :key="tool.name" type="button" :aria-pressed="configuration.enabledTools.includes(tool.name)" :class="{ enabled: configuration.enabledTools.includes(tool.name) }" @click="toggleTool(tool.name)"><i>{{ tool.icon || '•' }}</i><span><small>{{ tool.kind === 'consult' ? 'Read only' : tool.kind === 'mutate' ? 'Changes data' : 'External action' }}</small><strong>{{ tool.title || tool.name }}</strong><p>{{ tool.help || tool.description }}</p></span><b></b></button></div>
          </section>

          <section v-else-if="step === 'confirmations'" class="step-panel">
            <div class="step-heading"><span>05</span><div><h3>Channels and confirmations</h3><p>Choose tool behavior per channel and require a new caller turn before selected mutations.</p></div></div>
            <div class="channel-grid">
              <article v-for="channel in (['phone','voice_lab'] as const)" :key="channel" class="policy-card"><h4>{{ channel === 'phone' ? 'Phone' : 'Voice Lab' }}</h4>
                <label>Tool choice<select v-model="configuration.toolPolicies.channels[channel].toolChoice"><option value="auto">Auto</option><option value="required">Required</option><option value="none">None</option></select></label>
                <label class="check-row"><input v-model="configuration.toolPolicies.channels[channel].parallelToolCalls" type="checkbox" :disabled="!channelCanParallel(channel)"><span>Parallel read-only calls</span></label>
                <small v-if="!channelCanParallel(channel)">Available only when every enabled tool is read-only.</small>
              </article>
            </div>
            <div class="confirmation-list"><button v-for="tool in mutableTools" :key="tool.name" type="button" :disabled="!configuration.enabledTools.includes(tool.name)" :class="{ enabled: configuration.toolPolicies.confirmations.requiredFor.includes(tool.name) }" @click="toggleConfirmation(tool.name)"><strong>{{ tool.title }}</strong><small>{{ configuration.toolPolicies.confirmations.requiredFor.includes(tool.name) ? 'Two-turn confirmation required' : 'Normal caller agreement' }}</small></button></div>
          </section>

          <section v-else-if="step === 'limits'" class="step-panel">
            <div class="step-heading"><span>06</span><div><h3>Limits and escalation</h3><p>Bound tool activity and decide when a safe human transfer should be attempted.</p></div></div>
            <div class="field-grid">
              <label>Total tools per call<input v-model.number="configuration.toolPolicies.limits.totalPerCall" type="number" min="1" max="100"></label>
              <label>External attempts<select v-model.number="configuration.toolPolicies.externalRetryAttempts"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option></select></label>
            </div>
            <div class="per-tool-limits"><label v-for="tool in enabledToolDescriptors" :key="tool.name">{{ tool.title }}<input v-model.number="configuration.toolPolicies.limits.perTool[tool.name]" type="number" min="1" max="100" placeholder="Use total limit"></label></div>
            <div class="policy-card escalation-card"><h4>Automatic human escalation</h4><label class="check-row"><input v-model="configuration.toolPolicies.automaticTransfer.onLimitReached" type="checkbox" :disabled="!canAutoTransfer"><span>Transfer when a tool limit is reached</span></label><label class="check-row"><input v-model="configuration.toolPolicies.automaticTransfer.onRetryableFailure" type="checkbox" :disabled="!canAutoTransfer"><span>Transfer after retryable external failure</span></label><small>{{ canAutoTransfer ? 'Transfer uses only the destination configured for the trusted branch.' : 'Enable transfer_to_human in both channels first.' }}</small></div>
          </section>

          <section v-else class="step-panel">
            <div class="step-heading"><span>04</span><div><h3>Core instructions</h3><p>Describe YIBO's role, tone, and limits with clear rules.</p></div></div>
            <label class="prompt-field">Active instructions<textarea v-model="configuration.identity.instructions" rows="12"></textarea><small>Do not include secrets or personal data. {{ configuration.identity.instructions.length }} characters.</small></label>
          </section>

          <div class="step-actions"><button type="button" :disabled="currentStep === 0" @click="move(-1)">← Previous</button><span>Step {{ currentStep + 1 }} of {{ steps.length }}</span><button type="button" :disabled="currentStep === steps.length - 1" @click="move(1)">Next →</button></div>
        </div>

        <aside class="agent-preview">
          <small>PREVIEW</small><div class="voice-orb"><i></i><i></i><i></i><i></i><i></i></div>
          <h3>{{ selectedCapability?.label ?? configuration.conversation.model }}</h3><p>Voice <strong>{{ configuration.audio.voice }}</strong> · {{ configuration.identity.locale }}</p>
          <blockquote>“{{ configuration.identity.locale.startsWith('en') ? "Hello, I'm YIBO. How can I help?" : 'Hola, soy YIBO. ¿En qué puedo ayudarte?' }}”</blockquote>
          <button type="button" class="preview-button" @click="emit('preview')">Open saved-settings Voice Lab</button>
          <small class="preview-note">Uses the real OpenAI voice and may incur API charges. Save your edits first; this preview uses saved settings, not unsaved changes. Audio starts only when you start the Voice Test.</small>
          <dl><div><dt>Response</dt><dd>{{ configuration.conversation.maxOutputTokens }} max tokens</dd></div><div><dt>Capabilities</dt><dd>{{ activeToolCount }} active</dd></div><div><dt>Protection</dt><dd>Trusted context</dd></div></dl>
        </aside>
      </div>

      <p v-if="error" class="config-error" role="alert">{{ error }}</p>
      <button v-if="conflict" type="button" @click="load">Discard draft and reload latest settings</button>
      <footer class="config-actions"><div><strong>{{ saved ? 'Settings saved' : hasFieldErrors ? 'Review highlighted fields' : 'Applies to the next conversation' }}</strong><small>The active runtime does not change in the middle of a call.</small></div><button type="button" class="restore" @click="restoreRecommended">Restore recommended</button><button class="save" :disabled="saving || hasFieldErrors || conflict">{{ saving ? 'Saving…' : 'Save settings' }}</button></footer>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
.field-error{color:#c43855;font-size:11px;font-style:normal;font-weight:700}.compact-fields{margin-bottom:24px}.behavior-fields{margin-top:24px}.compact-prompt{margin-top:20px}.compact-prompt input{padding:13px}.channel-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.policy-card{padding:18px;border:1px solid var(--ac-line);border-radius:10px;background:#fffaf2}.policy-card h4{margin:0 0 15px;color:var(--blue-deep);font-family:Georgia,serif}.check-row{display:flex!important;grid-template-columns:none!important;align-items:center;gap:10px;margin-top:14px}.check-row input{width:auto}.confirmation-list{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}.confirmation-list button{display:grid;gap:4px;padding:14px;text-align:left;border:1px solid #d1c5b7;border-radius:8px;background:#fbf7ef;color:#403833}.confirmation-list button.enabled{border-color:#2854c7;box-shadow:inset 4px 0 #2854c7;background:#e8edf4}.confirmation-list button:disabled{opacity:.45}.confirmation-list small,.policy-card>small{color:#7d8079}.per-tool-limits{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:20px}.escalation-card{margin-top:20px}
.agent-config{--ac-bg:#07151c;--ac-panel:#0c2029;--ac-line:#24444e;--ac-mint:#5ee8c4;--ac-amber:#f6c85f;--ac-ink:#eaf7f4;color:var(--ac-ink);background:linear-gradient(145deg,#091a21,#061117);border:1px solid var(--ac-line);clip-path:polygon(18px 0,100% 0,100% calc(100% - 18px),calc(100% - 18px) 100%,0 100%,0 18px);overflow:hidden;box-shadow:0 30px 80px #0007}.config-intro{display:flex;justify-content:space-between;gap:30px;padding:42px 46px 32px;background:radial-gradient(circle at 80% 0,#133c3c 0,transparent 35%)}.config-intro h2{margin:0 0 10px;color:#fff;font-size:clamp(28px,4vw,48px);text-transform:none;text-shadow:none}.config-intro p:not(.config-kicker){max-width:680px;color:#91afb3}.config-kicker{color:var(--ac-mint);font:700 11px/1 monospace;letter-spacing:.2em}.connection-chip{height:max-content;display:flex;align-items:center;gap:8px;padding:10px 13px;background:#321d22;border:1px solid #6a3d45;color:#ff9b9b;font:700 11px/1 monospace;text-transform:uppercase}.connection-chip i{width:7px;height:7px;border-radius:50%;background:currentColor}.connection-chip.ready{background:#12352e;border-color:#296958;color:var(--ac-mint)}.config-state{min-height:300px;display:grid;place-content:center;gap:15px;color:#91afb3}.config-state i{width:38px;height:38px;border:3px solid var(--ac-line);border-top-color:var(--ac-mint);border-radius:50%;animation:spin 1s linear infinite}.error-state{color:#ff9a9a}.config-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:0;padding:0 46px;border-bottom:1px solid var(--ac-line)}.config-steps button{display:flex;gap:10px;align-items:center;padding:17px 12px;border:0;border-bottom:3px solid transparent;background:transparent;color:#6f8e93;text-align:left}.config-steps button small{color:#52747a;font-family:monospace}.config-steps button.active{color:#fff;border-color:var(--ac-mint);background:#0d242c}.config-steps button.complete small{color:var(--ac-mint)}.config-layout{display:grid;grid-template-columns:minmax(0,1fr) 310px}.config-stage{padding:40px 42px 24px;min-width:0}.step-panel{animation:enter .24s ease-out}.step-heading{display:flex;gap:16px;align-items:flex-start;margin-bottom:28px}.step-heading>span{width:45px;height:45px;display:grid;place-items:center;flex:none;background:var(--ac-mint);color:#06201a;font-weight:900;border-radius:14px 4px 14px 5px}.step-heading h3{margin:0 0 5px;color:#fff;font:700 25px/1.1 inherit}.step-heading p{margin:0;color:#84a1a6}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.field-grid label,.token-control,.advanced-grid label,.prompt-field{display:grid;gap:8px;color:#d9e8e6;font-weight:700}.field-grid small,.token-control small,.prompt-field small{color:#729196;font-weight:400;line-height:1.4}.field-grid select,.prompt-field textarea{width:100%;border:1px solid #31545e;background:#08171d;color:#eaf7f4;padding:13px;border-radius:9px}.field-grid select:focus,.prompt-field textarea:focus{outline:2px solid #5ee8c455;border-color:var(--ac-mint)}.token-control{margin-top:24px;padding:18px;background:#0b1d24;border-left:4px solid var(--ac-amber)}.token-control>span{display:flex;justify-content:space-between}.token-control output,.advanced output{color:var(--ac-mint)}input[type=range]{accent-color:var(--ac-mint)}.preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.preset-grid button{display:grid;grid-template-columns:38px 1fr;text-align:left;gap:10px;padding:15px;border:1px solid var(--ac-line);border-radius:12px;background:#0a1b22;color:#dcecea}.preset-grid button i{grid-row:1/3;width:34px;height:34px;display:grid;place-items:center;background:#16323a;color:var(--ac-mint);font-style:normal;border-radius:10px}.preset-grid button small{color:#779499;line-height:1.4}.preset-grid button.selected{border-color:var(--ac-mint);background:#102d2c;box-shadow:inset 4px 0 0 var(--ac-mint)}.advanced{margin-top:22px;border:1px solid var(--ac-line);background:#09191f;padding:15px}.advanced summary{display:flex;justify-content:space-between;color:#cde0dd;cursor:pointer;font-weight:700}.advanced summary span{color:var(--ac-amber);font-size:11px}.advanced>p{color:#78969a}.advanced-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.advanced-grid label{padding:12px;background:#0d2229}.advanced-grid output{font-size:12px}.permission-flow{display:flex;align-items:center;justify-content:center;margin:0 0 24px}.permission-flow span{display:grid;padding:11px 20px;border:1px solid var(--ac-line);background:#0a1b22;text-align:center}.permission-flow small{color:#759297}.permission-flow b{color:var(--ac-mint);padding:0 8px}.permission-flow .gate{border-color:var(--ac-mint);background:#13342f;color:var(--ac-mint)}.tool-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.tool-grid button{display:grid;grid-template-columns:38px 1fr 36px;gap:12px;padding:16px;text-align:left;border:1px solid var(--ac-line);background:#091a21;color:#dbe9e7;border-radius:13px}.tool-grid button>i{width:36px;height:36px;display:grid;place-items:center;background:#173039;color:#91adb1;border-radius:10px;font:normal 22px/1 inherit}.tool-grid button span{display:grid;gap:3px}.tool-grid button span>small{color:#708e93;text-transform:uppercase;font-size:9px;letter-spacing:.08em}.tool-grid button p{margin:5px 0;color:#7e9b9f;font-size:12px;line-height:1.45}.tool-grid button em{color:#557b7e;font-size:10px;font-style:normal}.tool-grid button>b{width:34px;height:20px;padding:3px;border-radius:20px;background:#293e43}.tool-grid button>b:after{content:"";display:block;width:14px;height:14px;border-radius:50%;background:#73878a;transition:.2s}.tool-grid button.enabled{border-color:#397b6d;background:#102722}.tool-grid button.enabled>i{background:#17473d;color:var(--ac-mint)}.tool-grid button.enabled>b{background:#269c82}.tool-grid button.enabled>b:after{transform:translateX(14px);background:#fff}.security-note{padding:14px;border:1px solid #315063;background:#0e1e2a;color:#8ca6ae;font-size:12px}.prompt-field textarea{min-height:280px;resize:vertical;line-height:1.65}.step-actions{display:flex;align-items:center;justify-content:space-between;margin-top:28px;padding-top:18px;border-top:1px solid var(--ac-line)}.step-actions button{border:0;background:transparent;color:var(--ac-mint);padding:8px}.step-actions button:disabled{opacity:.25}.step-actions span{color:#66868b;font-size:11px}.agent-preview{padding:38px 24px;border-left:1px solid var(--ac-line);background:linear-gradient(180deg,#0d2229,#08171d);text-align:center}.agent-preview>small:first-child{color:#68898e;letter-spacing:.17em}.voice-orb{width:112px;height:112px;margin:28px auto 20px;display:flex;align-items:center;justify-content:center;gap:4px;border-radius:38px;background:radial-gradient(circle,#236858,#102a2b 65%);box-shadow:0 0 0 7px #173139,0 0 45px #37d4b32e}.voice-orb i{width:4px;height:36px;background:var(--ac-mint);border-radius:5px;animation:wave 1.2s ease-in-out infinite}.voice-orb i:nth-child(2),.voice-orb i:nth-child(4){height:22px;animation-delay:.18s}.voice-orb i:first-child,.voice-orb i:last-child{height:12px;animation-delay:.32s}.agent-preview h3{margin:0 0 5px;color:#fff;text-transform:capitalize}.agent-preview>p{color:#759399}.agent-preview blockquote{margin:22px 0 12px;padding:15px;background:#142b33;color:#c8dbd9;text-align:left;border-radius:14px;line-height:1.5}.preview-button{width:100%;border:1px solid #397165;background:#13362f;color:var(--ac-mint);padding:10px;border-radius:10px;font-weight:700}.preview-note{display:block;margin:8px 0 20px;color:#627f83;line-height:1.4}.agent-preview dl{display:grid;gap:0;text-align:left}.agent-preview dl div{display:flex;justify-content:space-between;padding:10px 3px;border-bottom:1px solid #203940}.agent-preview dt{color:#78979b}.agent-preview dd{margin:0;color:#b6cecb}.config-error{margin:0 42px 15px;padding:12px 14px;border:1px solid #7a3b45;background:#301b21;color:#ffaaaa}.config-actions{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;padding:16px 42px;border-top:1px solid var(--ac-line);background:#08171df2;backdrop-filter:blur(14px)}.config-actions>div{display:grid;margin-right:auto}.config-actions small{color:#69888d}.config-actions button{padding:11px 15px;border-radius:9px;font-weight:700}.restore{border:1px solid #31515a;background:transparent;color:#a9c4c2}.save{border:0;background:var(--ac-mint);color:#062019}.save:disabled{opacity:.55}@keyframes spin{to{transform:rotate(360deg)}}@keyframes enter{from{opacity:0;transform:translateY(7px)}}@keyframes wave{50%{transform:scaleY(.45)}}@media(max-width:1050px){.config-layout{grid-template-columns:1fr}.agent-preview{border-left:0;border-top:1px solid var(--ac-line)}.advanced-grid{grid-template-columns:1fr}.agent-preview dl{max-width:500px;margin:auto}}@media(max-width:700px){.config-intro{padding:28px 22px;flex-direction:column}.connection-chip{width:max-content}.config-steps{padding:0;overflow:auto}.config-steps button{min-width:130px}.config-stage{padding:28px 20px 20px}.field-grid,.preset-grid,.tool-grid{grid-template-columns:1fr}.permission-flow{font-size:11px}.permission-flow span{padding:9px}.config-actions{padding:14px 20px;flex-wrap:wrap}.config-actions>div{width:100%}.config-actions button{flex:1}}
</style>

<style scoped>
.config-steps{grid-template-columns:repeat(7,minmax(105px,1fr));overflow-x:auto}.config-steps button{min-width:105px}
/* Segunda escena en azul y blanco: clara, silenciosa y fácil de recorrer. */
.agent-config{--ac-bg:#fff;--ac-panel:#fff;--ac-line:#c8daf1;--ac-mint:#2354d7;--ac-amber:#76bfff;--ac-ink:#17254a;color:#17254a;border-color:#b9d2ee;border-radius:5px 36px 7px 22px;background:#fff;box-shadow:0 24px 70px #214d941d,9px 10px 0 #9fd0ff}.config-intro{min-height:190px;padding:38px 5% 30px;background:linear-gradient(132deg,#fff 0 76%,#d9ecff 76%)}.config-intro:before{width:185px;height:185px;right:9%;top:-128px;border-color:#2354d7;opacity:.82}.config-intro:after{width:185px;height:7px;left:5%;bottom:24px;background:#76bfff}.config-intro h2{color:#102a68}.config-intro p:not(.config-kicker){color:#697b9e}.config-kicker{color:#2354d7}.connection-chip{color:#2354d7;border-color:#a9c7ea;background:#edf5ff}.connection-chip.ready{color:#1c7047;border-color:#afd8c1;background:#e6f6ed}.config-steps{padding:0 5%;border-color:#c9d9ee;background:#e8f2ff}.config-steps button{color:#7181a2}.config-steps button small{color:#8193b6}.config-steps button.active{color:#fff;border-color:#2354d7;background:#2354d7}.config-steps button.active small{color:#dceaff}.config-steps button.complete small{color:#2354d7}.config-layout{background:#fff}.config-stage{padding:39px 5% 25px}.step-heading>span{color:#fff;background:#2354d7;box-shadow:4px 5px 0 #9dccff}.step-heading h3{color:#15306e}.step-heading p{color:#7484a3}.field-grid label,.token-control,.advanced-grid label,.prompt-field{color:#31456f}.field-grid small,.token-control small,.prompt-field small{color:#7b8baa}.field-grid select,.prompt-field textarea{color:#182750;border-color:#b8cce7;background:#fbfdff}.field-grid select:focus,.prompt-field textarea:focus{border-color:#2354d7;box-shadow:0 0 0 4px #2354d713}.token-control{border-color:#2354d7;background:#e8f2ff}.token-control output,.advanced output{color:#2354d7}input[type=range]{accent-color:#2354d7}.preset-grid button{color:#243964;border-color:#c6d7ed;background:#f8fbff}.preset-grid button i{color:#2354d7;background:#e4f0ff}.preset-grid button small{color:#7789aa}.preset-grid button.selected{border-color:#3c70df;background:#e1edff;box-shadow:inset 5px 0 0 #2354d7}.advanced{border-color:#c5d6ec;background:#edf4fc}.advanced summary{color:#31456e}.advanced summary span{color:#2354d7}.advanced>p{color:#7b8dab}.advanced-grid label{background:#fff}.permission-flow span{color:#344971;border-color:#c3d4eb;background:#f3f8ff}.permission-flow small{color:#8292b0}.permission-flow b{color:#2354d7}.permission-flow .gate{color:#fff;border-color:#173b9c;background:#2354d7}.permission-flow .gate small{color:#d5e5ff}.tool-grid button{color:#2e416b;border-color:#c2d4ea;background:#f9fcff}.tool-grid button>i{color:#2354d7;background:#e4f0ff}.tool-grid button span>small{color:#7b8dab}.tool-grid button p{color:#6f81a2}.tool-grid button em{color:#6080b1}.tool-grid button>b{background:#d3dfed}.tool-grid button.enabled{border-color:#5885e4;background:#e5efff}.tool-grid button.enabled>i{color:#fff;background:#2354d7}.tool-grid button.enabled>b{background:#2354d7}.security-note{color:#345d7a;border-color:#afd1e8;border-left-color:#338ed0;background:#e6f5ff}.step-actions{border-color:#d5e1f1}.step-actions button{color:#2354d7}.step-actions span{color:#8291ad}.agent-preview{margin:24px 20px 36px -3px;color:#fff;border-radius:29px 6px 22px 7px;background:linear-gradient(155deg,#14358d,#2354d7 70%,#4b8cf2);box-shadow:8px 9px 0 #9fd1ff}.agent-preview>small:first-child{color:#c3d8ff}.voice-orb{background:radial-gradient(circle,#77bcff,#2354d7 68%);box-shadow:0 0 0 7px #4d7add,8px 9px 0 #0f2b70}.voice-orb i{background:#fff}.agent-preview h3{color:#fff}.agent-preview>p{color:#d1e1ff}.agent-preview blockquote{color:#15306b;background:#e4f2ff}.preview-button{color:#fff;border-color:#9ac8ff;background:#1746bd}.preview-button:hover{background:#2860d8}.preview-note{color:#bdd3fa}.agent-preview dl div{border-color:#ffffff26}.agent-preview dt{color:#c6d9fa}.agent-preview dd{color:#fff}.config-error{color:#8b2b3d;border-color:#e2aab4;background:#fff0f2}.config-actions{margin:0 3% 17px 5%;border-color:#c7d8ed;background:#f3f8ffee}.config-actions strong{color:#27406c}.config-actions small{color:#7889a8}.restore{color:#506b9d;border-color:#b7cbe6}.save{color:#fff;background:#2354d7;box-shadow:4px 5px 0 #9bcaff}.save:hover:not(:disabled){box-shadow:2px 3px 0 #9bcaff}@media(max-width:700px){.config-intro{background:#fff}.config-intro:before{opacity:.35}}
</style>

<style scoped>
/* Nocturne: la prueba es protagonista; la configuración queda como segundo acto. */
.agent-config{color:#2b2425;border:1px solid #cfc2b3;border-radius:5px 34px 7px 21px;background:#f4ecdf;box-shadow:0 24px 70px #0006,9px 10px 0 #712434}.config-intro{min-height:190px;align-items:center;padding:38px 5% 30px;background:linear-gradient(132deg,#20191c 0 76%,#4f2430 76%)}.config-intro:before{width:180px;height:180px;right:9%;top:-126px;border:25px solid #df4b59;opacity:.7}.config-intro:after{width:180px;height:7px;left:5%;bottom:24px;background:#f0a071}.config-intro h2{max-width:620px;color:#fff7ed;font-size:clamp(36px,4vw,54px)}.config-intro p:not(.config-kicker){max-width:680px;color:#bba9ae}.config-kicker{color:#f0a071}.connection-chip{color:#efb8bf;border-color:#793a48;background:#3b2028}.connection-chip.ready{color:#cbd6c5;border-color:#66715f;background:#293027}.config-steps{padding:0 5%;border-color:#d0c4b6;background:#ded3c6}.config-steps button{color:#776a64}.config-steps button.active{color:#3b272e;border-color:#df4b59;background:#f4ecdf}.config-steps button.complete small{color:#b02f44}.config-layout{grid-template-columns:minmax(0,1fr) 310px;background:#f4ecdf}.config-stage{padding:39px 5% 25px}.step-heading>span{background:#df4b59;box-shadow:4px 5px 0 #7c2333}.step-heading h3{color:#3d2930}.field-grid select,.prompt-field textarea{background:#fffaf2}.token-control{border-color:#df4b59;background:#e6dacb}.token-control output,.advanced output{color:#a02f42}input[type=range]{accent-color:#df4b59}.preset-grid button{background:#f9f3e9}.preset-grid button i{color:#9f3042;background:#efd9dc}.preset-grid button.selected{border-color:#bd4457;background:#f0dadd;box-shadow:inset 5px 0 0 #df4b59}.advanced{background:#e8ded1}.permission-flow .gate{border-color:#4d2630;background:#4d2630}.permission-flow b{color:#b42e44}.tool-grid button{background:#faf4ea}.tool-grid button>i{color:#a42e43;background:#f0dade}.tool-grid button.enabled{border-color:#bc5768;background:#efdadd}.tool-grid button.enabled>i{background:#a52f43}.security-note{border-color:#adb9a8;border-left-color:#71806f;background:#dfe6da}.agent-preview{margin:24px 20px 36px -3px;border-radius:27px 6px 21px 7px;background:linear-gradient(155deg,#271c20,#4c2530 70%,#752d3f);box-shadow:8px 9px 0 #e36b70;transform:none}.voice-orb{background:radial-gradient(circle,#d75b69,#6f2939 68%);box-shadow:0 0 0 7px #66313e,8px 9px 0 #170f12}.voice-orb i{background:#f4c092}.agent-preview blockquote{background:#f2d9bc}.preview-button{border-color:#c46f7d;background:#762d3f}.config-actions{margin:0 3% 17px 5%;background:#eee4d7ee}.save{background:#df4b59;box-shadow:4px 5px 0 #7c2333}.save:hover:not(:disabled){box-shadow:2px 3px 0 #7c2333}@media(max-width:1050px){.config-layout{grid-template-columns:1fr}.agent-preview{margin:8px 8% 40px}}@media(max-width:700px){.config-intro{padding:31px 23px 46px;background:#21191c}.config-intro h2{font-size:38px}.agent-preview{margin:8px 22px 34px}.config-actions{margin:0}}
</style>

<style scoped>
/* Dirección editorial de YIBO: cálida, táctil y deliberadamente imperfecta. */
.agent-config {
  --ac-bg: #fbf7ef;
  --ac-panel: #fffdf8;
  --ac-line: #d7ccbe;
  --ac-mint: #8d3448;
  --ac-amber: #d39a4a;
  --ac-ink: #28231f;
  color: var(--ac-ink);
  background: #fbf7ef;
  border: 1px solid #d1c5b7;
  border-radius: 8px 46px 9px 26px;
  clip-path: none;
  box-shadow: 12px 16px 0 #d9cfc2, 0 35px 90px #5c3e2d20;
  overflow: hidden;
}

.config-intro {
  position: relative;
  min-height: 225px;
  align-items: flex-end;
  padding: 48px 6% 38px;
  overflow: hidden;
  background: #f8f1e7;
  isolation: isolate;
}
.config-intro::before {
  content: "";
  position: absolute;
  width: 245px;
  height: 245px;
  right: 7%;
  top: -135px;
  border: 28px solid #e6b25f;
  border-radius: 48% 52% 43% 57%;
  transform: rotate(19deg);
  z-index: -1;
}
.config-intro::after {
  content: "";
  position: absolute;
  width: 230px;
  height: 10px;
  left: 5%;
  bottom: 20px;
  background: #8d3448;
  clip-path: polygon(0 28%, 100% 0, 96% 65%, 3% 100%);
  transform: rotate(-1.2deg);
  z-index: -1;
}
.config-intro h2 {
  max-width: 720px;
  color: #31272a;
  font: 500 clamp(39px, 5vw, 64px)/.98 "Iowan Old Style", Georgia, serif;
  letter-spacing: -.055em;
}
.config-intro p:not(.config-kicker) { max-width: 620px; color: #6b625b; font-size: 15px; line-height: 1.55; }
.config-kicker { color: #8d3448; letter-spacing: .18em; }
.connection-chip { color: #823847; border: 1px solid #c88c97; border-radius: 999px; background: #f3dfe2; }
.connection-chip.ready { color: #405043; border-color: #a6b5a2; background: #dfe6db; }

.config-steps { padding: 0 6%; border-color: #d7ccbe; background: #f2ebe1; }
.config-steps button { color: #81766d; border-radius: 16px 16px 0 0; }
.config-steps button small { color: #9a8b81; }
.config-steps button.active { color: #3e2930; border-color: #8d3448; background: #fffaf2; }
.config-steps button.complete small { color: #8d3448; }

.config-layout { grid-template-columns: minmax(0, 1fr) 320px; background: #fffaf2; }
.config-stage { padding: 45px 5% 28px 6%; }
.step-heading>span { color: #fff8ef; background: #8d3448; border-radius: 48% 41% 53% 38%; box-shadow: 4px 5px 0 #e4b45f; transform: rotate(-5deg); }
.step-heading h3 { color: #3d2930; font: 500 29px/1.1 "Iowan Old Style", Georgia, serif; }
.step-heading p { color: #786e66; }

.field-grid label, .token-control, .advanced-grid label, .prompt-field { color: #453d37; }
.field-grid small, .token-control small, .prompt-field small { color: #81766d; }
.field-grid select, .prompt-field textarea { color: #2e2925; border: 1px solid #bfb2a4; border-radius: 7px 17px 7px 12px; background: #fffdf8; }
.field-grid select:focus, .prompt-field textarea:focus { border-color: #8d3448; box-shadow: 0 0 0 4px #8d344814; }
.token-control { padding: 18px 20px; border-left: 5px solid #d39a4a; border-radius: 0 16px 16px 0; background: #efe6da; }
.token-control output, .advanced output { color: #8d3448; }
input[type=range] { accent-color: #8d3448; }

.preset-grid button { color: #37302b; border-color: #d2c7ba; border-radius: 7px 19px 7px 13px; background: #fbf7f0; }
.preset-grid button:nth-child(even) { transform: translateY(8px); }
.preset-grid button i { color: #8d3448; background: #f0dfe1; }
.preset-grid button small { color: #80756c; }
.preset-grid button.selected { border-color: #8d3448; background: #f4e4e6; box-shadow: inset 5px 0 0 #8d3448; }
.advanced { border-color: #d2c7ba; border-radius: 7px 18px 7px 13px; background: #f0e9df; }
.advanced summary { color: #453b35; }
.advanced summary span { color: #8d3448; }
.advanced>p { color: #81766d; }
.advanced-grid label { background: #fffaf3; }

.permission-flow span { color: #4b423c; border-color: #ccbfb1; background: #f5eee4; }
.permission-flow small { color: #8a7e74; }
.permission-flow b { color: #8d3448; }
.permission-flow .gate { color: #fff7ee; border-color: #4a2630; background: #4a2630; }
.permission-flow .gate small { color: #d8bdc3; }
.tool-grid button { color: #403833; border-color: #d1c5b7; border-radius: 7px 20px 7px 14px; background: #fbf7ef; }
.tool-grid button>i { color: #8d3448; background: #f1e0e2; }
.tool-grid button span>small { color: #927f76; }
.tool-grid button p { color: #766c64; }
.tool-grid button em { color: #8d736d; }
.tool-grid button>b { background: #d6cec4; }
.tool-grid button>b::after { background: #8f867f; }
.tool-grid button.enabled { border-color: #9e5665; background: #f3e2e4; }
.tool-grid button.enabled>i { color: #fff8ef; background: #8d3448; }
.tool-grid button.enabled>b { background: #8d3448; }
.security-note { color: #566057; border-color: #b9c2b4; border-left: 5px solid #728075; background: #e6ebe2; }

.prompt-field textarea { min-height: 310px; }
.step-actions { border-color: #d8cec0; }
.step-actions button { color: #8d3448; }
.step-actions span { color: #887d74; }

.agent-preview {
  position: relative;
  margin: 28px 24px 40px -4px;
  padding: 40px 25px 30px;
  color: #fff8ef;
  border: 0;
  border-radius: 33px 7px 25px 8px;
  background: linear-gradient(160deg, #3e2b31, #4f2934 68%, #6b3040);
  box-shadow: 10px 12px 0 #e0b05d;
  transform: rotate(.35deg);
}
.agent-preview>small:first-child { color: #cbb7bb; }
.voice-orb { background: radial-gradient(circle, #ac4c60, #6d2f3e 68%); box-shadow: 0 0 0 7px #6c3a46, 9px 11px 0 #2f2226; }
.voice-orb i { background: #f1c671; }
.agent-preview h3 { color: #fff8ef; font: 500 25px/1.1 "Iowan Old Style", Georgia, serif; }
.agent-preview>p { color: #d6bdc2; }
.agent-preview blockquote { color: #352a28; border-radius: 5px 18px 7px 14px; background: #f4dfb9; font-family: "Iowan Old Style", Georgia, serif; font-size: 17px; }
.preview-button { width: auto; color: #fff4e8; border-color: #bd7c89; border-radius: 999px; background: #6c3040; }
.preview-button:hover { background: #84394d; }
.preview-note { color: #bda5aa; }
.agent-preview dl div { border-color: #ffffff1a; }
.agent-preview dt { color: #c8b0b5; }
.agent-preview dd { color: #fff4e8; }

.config-error { color: #6d2836; border-color: #c88f99; background: #f2dcdf; }
.config-actions { margin: 0 3% 18px 6%; padding: 15px 18px; border: 1px solid #d2c6b9; border-radius: 18px 6px 16px 7px; background: #f7f1e8ee; box-shadow: 0 12px 30px #61443219; }
.config-actions strong { color: #433a35; }
.config-actions small { color: #857970; }
.restore { color: #6c4f52; border-color: #bdaeb0; background: transparent; }
.save { color: #fff8ef; background: #8d3448; box-shadow: 4px 5px 0 #4a2630; }
.save:hover:not(:disabled) { transform: translate(2px, 2px); box-shadow: 2px 3px 0 #4a2630; }

@media(max-width:1050px) {
  .config-layout { grid-template-columns: 1fr; }
  .agent-preview { margin: 10px 8% 45px; }
}
@media(max-width:700px) {
  .agent-config { border-radius: 6px 27px 7px 18px; box-shadow: 6px 9px 0 #d9cfc2; }
  .config-intro { min-height: auto; padding: 36px 25px 50px; }
  .config-intro h2 { font-size: 40px; }
  .config-intro::before { opacity: .45; }
  .preset-grid button:nth-child(even) { transform: none; }
  .agent-preview { display: block; margin: 10px 24px 38px; }
  .config-actions { margin: 0; border-width: 1px 0 0; border-radius: 0; }
}
</style>
