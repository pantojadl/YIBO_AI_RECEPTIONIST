<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { api, type RealtimeModelCapability } from "../services/api";
import { emptyRealtimeCostState, observeRealtimeCostEvent, estimateRealtimeCost } from "../services/realtime-cost";
import { previewBlockReason } from "../services/voice-preview";
import RecentActivity from "./RecentActivity.vue";
import { VoiceLabSession, type VoiceLabSnapshot } from "../../../apps/dev-voice/voice-lab-session.js";
const props = defineProps<{ expectedTenantId?: string }>();
const session = shallowRef<VoiceLabSnapshot>({ phase: "connecting", connected: false,
  aiConnected: false, microphoneActive: false, speaking: false, testNumber: 0 });
const events = ref<string[]>([]);
const previewMetadata = computed(() => session.value.configuration);
const previewBlocked = computed(() => previewBlockReason(props.expectedTenantId, previewMetadata.value));
const connected = computed(() => session.value.connected);
const aiSessionConnected = computed(() => session.value.aiConnected);
const microphoneActive = computed(() => session.value.microphoneActive);
const sessionUsed = computed(() => ["starting", "active"].includes(session.value.phase));
const state = computed(() => session.value.speaking ? "speaking" : microphoneActive.value ? "listening" : session.value.phase);
const canStart = computed(() => !microphoneActive.value && !["connecting", "starting"].includes(session.value.phase)
  && (["completed", "error"].includes(session.value.phase) || !previewBlocked.value));
const calendarToolsAvailable = ref(false);
const clinicTimezone = ref("Loading…");
const calendarStatus = ref<"connected" | "needs setup" | "unavailable">("unavailable");
const costState = shallowRef(emptyRealtimeCostState());
const modelCapabilities = ref<RealtimeModelCapability[]>([]);
const selectedPricing = computed(() => modelCapabilities.value.find(item => item.id === previewMetadata.value?.model)?.pricing);
const elapsedSeconds = ref(0);
let clockTimer: ReturnType<typeof setInterval> | undefined;
const sessionUsage = computed(() => costState.value.usage);
const estimatedCost = computed(() => estimateRealtimeCost(costState.value.usage, selectedPricing.value));
const estimatedCostPerMinute = computed(() => elapsedSeconds.value >= 5 && estimatedCost.value !== null
  ? estimatedCost.value / elapsedSeconds.value * 60
  : null);
const elapsedLabel = computed(() => `${String(Math.floor(elapsedSeconds.value / 60)).padStart(2, "0")}:${String(elapsedSeconds.value % 60).padStart(2, "0")}`);
const textTokens = computed(() => costState.value.usage.inputTextTokens + costState.value.usage.outputTextTokens);
const audioTokens = computed(() => costState.value.usage.inputAudioTokens + costState.value.usage.outputAudioTokens);
const statusCopy = computed(() => ({
  connecting: ["Connecting your studio", "Preparing the audio channel"],
  ready: ["Ready when you are", "The microphone is off"],
  starting: ["Starting your test", "Preparing the microphone and conversation"],
  active: ["Test in progress", "The microphone is paused"],
  listening: ["YIBO is listening", "Speak naturally; you can interrupt too"],
  speaking: ["YIBO is responding", "Try speaking over YIBO to test interruption"],
  completed: ["Test completed", "Activity is saved below. You can start another test."],
  error: ["Test interrupted", "Check Recent activity, then try another test."],
}[state.value]));
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const lab = new VoiceLabSession({
  url: `${protocol}//${window.location.hostname}:4317/voice`,
  blockReason: metadata => previewBlockReason(props.expectedTenantId, metadata),
  onState: snapshot => { session.value = snapshot; },
  onActivity: observeEvent,
});
onMounted(() => { void lab.connect().catch(() => {}); void loadDeveloperReadiness(); clockTimer = setInterval(updateElapsed, 1_000); });
onBeforeUnmount(() => { lab.dispose(); if (clockTimer) clearInterval(clockTimer); });

async function loadDeveloperReadiness(): Promise<void> {
  try {
    const [business, calendar, configuration] = await Promise.all([
      api.business(), api.googleCalendarStatus(), api.agentConfiguration(),
    ]);
    modelCapabilities.value = configuration.modelCapabilities;
    clinicTimezone.value = business.timezone;
    calendarStatus.value = calendar.connected ? "connected" : calendar.configured ? "needs setup" : "unavailable";
    const enabledTools = (configuration.current ?? configuration.recommended).enabledTools;
    calendarToolsAvailable.value = enabledTools.includes("check_availability") && enabledTools.includes("create_appointment");
  } catch {
    clinicTimezone.value = "Unavailable";
    calendarStatus.value = "unavailable";
  }
}

async function sendFixture(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await lab.sendFixture(file);
  input.value = "";
}

function observeEvent(message: Record<string, unknown>): void {
  costState.value = observeRealtimeCostEvent(costState.value, message, Date.now());
  updateElapsed();
  const name = String(message.event ?? message.type ?? "Activity");
  const labels: Record<string, string> = {
    "harness.connected": "Voice studio connected",
    "test.started": "Test started",
    "test.completed": `Test completed (${message.reason ?? "ended"})`,
    "conversation.opened": "Conversation started",
    "conversation.closed": "Conversation closed",
    "microphone.started": "Audio connected",
    "microphone.enabled": "Microphone enabled",
    "microphone.paused": "Microphone paused",
    "assistant.audio_received": "YIBO audio received",
    "conversation.interrupted": "Response interrupted",
    "playback.cleared": "Previous audio stopped",
    "fixture.sent": "WAV sent",
    "realtime.tool.started": "Tool started",
    "realtime.tool.completed": "Tool completed",
    "realtime.tool.failed": "Tool failed",
  };
  if (name === "audio.in" || name === "audio.out") return;
  let text = labels[name] ?? name;
  if (name === "assistant.transcript" && typeof message.transcript === "string") text = `YIBO said: ${message.transcript}`;
  if (typeof message.name === "string") text += `: ${message.name.replaceAll("_", " ")}`;
  if (typeof message.error === "string") text += `: ${message.error}`;
  const timestamp = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  const test = message.testNumber ? `Test ${message.testNumber} · ` : "";
  events.value.push(`${timestamp} · ${test}${text}`);
}
function updateElapsed(): void {
  const { startedAt, endedAt } = costState.value;
  elapsedSeconds.value = startedAt === undefined ? 0 : Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1_000));
}

function formatUsd(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value > 0 && value < 0.0001) return "< US$0.0001";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6,
  }).format(value);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

</script>

<template>
  <section class="voice-lab voice-lab-v2" aria-labelledby="voice-lab-title">
    <div class="lab-copy">
      <div class="lab-kicker"><span></span> LIVE TEST</div>
      <h2 id="voice-lab-title">Talk to your agent<br><em>before publishing it.</em></h2>
      <p>Preview the saved agent settings through Voice Lab. Unsaved edits are not included. This is a browser voice test, not a phone call. Starting the microphone or sending a WAV uses OpenAI and may incur charges.</p>
      <p v-if="previewBlocked" role="status">{{ previewBlocked }}</p>
      <p v-else>Saved model: {{ previewMetadata?.model }} · Voice: {{ previewMetadata?.voice }}</p>
      <div class="privacy"><span>Audio is not saved</span><span>Transcript is off</span><span class="cost">May use credits</span></div>
    </div>

    <div class="lab-experience">
      <div :class="['live-orb', state]"><div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="live-status"><small>AGENT STATUS</small><strong>{{ statusCopy[0] }}</strong><span>{{ statusCopy[1] }}</span></div>
      <div class="lab-controls">
        <button class="start" :disabled="!canStart" @click="lab.startMicrophone()">● {{ session.testNumber && !sessionUsed ? 'Start another test' : sessionUsed ? 'Resume microphone' : 'Start Voice Test' }}</button>
        <button :disabled="!microphoneActive" @click="lab.pauseMicrophone()">Pause microphone</button>
        <button :disabled="!sessionUsed" @click="lab.interrupt()">Interrupt YIBO</button>
        <button class="close" :disabled="!sessionUsed" @click="lab.finish()">End Voice Test</button>
      </div>
      <label class="fixture"><input type="file" accept="audio/wav,.wav" :disabled="!canStart" @change="sendFixture"><i>↥</i><span><strong>Use a WAV phrase</strong><small>Replay exactly the same audio to compare configurations.</small></span></label>
      <section class="live-cost" aria-live="polite" aria-label="Estimated live session cost">
        <header>
          <span><small>ESTIMATED SESSION COST</small><strong>{{ formatUsd(estimatedCost) }}</strong></span>
          <b :class="{ active: aiSessionConnected }"><i></i>{{ aiSessionConnected ? 'LIVE' : session.testNumber ? 'FINAL' : 'WAITING' }}</b>
        </header>
        <div class="cost-metrics">
          <span><small>Duration</small><strong>{{ elapsedLabel }}</strong></span>
          <span><small>Audio tokens</small><strong>{{ formatTokens(audioTokens) }}</strong></span>
          <span><small>Text/context tokens</small><strong>{{ formatTokens(textTokens) }}</strong></span>
          <span><small>Tool calls</small><strong>{{ formatTokens(sessionUsage.toolCalls) }}</strong></span>
          <span><small>Current pace</small><strong>{{ estimatedCostPerMinute === null ? '—' : `${formatUsd(estimatedCostPerMinute)}/min` }}</strong></span>
        </div>
        <footer>
          <span>Calculated after each model response from reported usage. Provider billing remains authoritative.</span>
          <a v-if="selectedPricing" :href="selectedPricing.sourceUrl" target="_blank" rel="noreferrer">{{ previewMetadata?.model }} rates · {{ selectedPricing.verifiedAt }}</a>
        </footer>
      </section>
    </div>

    <aside class="test-readiness" aria-label="Voice test readiness">
      <span :class="{ ready: connected }">{{ connected ? '✓' : '○' }} Microphone channel {{ connected ? 'ready' : session.phase === 'connecting' ? 'connecting' : 'closed' }}</span>
      <span :class="{ ready: aiSessionConnected }">{{ aiSessionConnected ? '✓' : '○' }} AI session {{ aiSessionConnected ? 'connected' : 'starts with the test' }}</span>
      <span :class="{ ready: calendarToolsAvailable }">{{ calendarToolsAvailable ? '✓' : '○' }} Calendar tools {{ calendarToolsAvailable ? 'available' : 'not available' }}</span>
      <span :class="{ ready: calendarStatus === 'connected' }">{{ calendarStatus === 'connected' ? '✓' : '○' }} Google Calendar {{ calendarStatus }}</span>
      <span>◷ Clinic timezone: <strong>{{ clinicTimezone }}</strong></span>
    </aside>

    <RecentActivity :entries="events" />
    <p class="credit-note">The OpenAI session starts only when you enable the microphone or send a WAV. Opening this screen does not use credits.</p>
  </section>
</template>

<style scoped>
.voice-lab{--red:#e24e5d;--red2:#9d2c3e;--cream:#f5ecdc;--black:#151214;position:relative;display:grid;grid-template-columns:minmax(330px,.83fr) minmax(520px,1.35fr);gap:28px;padding:42px clamp(28px,4vw,58px) 30px;color:var(--cream);border:1px solid #3b3034;border-radius:5px 38px 7px 24px;background:radial-gradient(circle at 14% 110%,#5e2634 0,transparent 34%),linear-gradient(145deg,#171315,#22191d);box-shadow:0 22px 70px #0008,9px 11px 0 #7e2938;overflow:hidden;isolation:isolate}.voice-lab:before{content:"";position:absolute;width:260px;height:260px;right:-110px;top:-170px;border:36px solid #e24e5d;border-radius:47% 53% 39% 61%;transform:rotate(18deg);opacity:.75;z-index:-1}.lab-copy{align-self:center}.lab-kicker{display:flex;align-items:center;gap:9px;color:#f0ae78;font-size:10px;font-weight:850;letter-spacing:.18em}.lab-kicker span{width:25px;height:2px;background:var(--red)}h2{margin:15px 0 17px;color:#fff8ee;font:500 clamp(38px,4.2vw,62px)/.91 "Iowan Old Style",Georgia,serif;letter-spacing:-.055em}h2 em{color:#f09a79;font-weight:500}.lab-copy>p{max-width:590px;color:#bfaeb2;line-height:1.55}.privacy{display:flex;flex-wrap:wrap;gap:7px;margin-top:23px}.privacy span{padding:7px 9px;border:1px solid #58454b;border-radius:99px;color:#c8b8bc;font-size:9px;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.privacy .cost{color:#eec485;border-color:#74532e;background:#392a1d}.lab-experience{display:grid;grid-template-columns:150px 1fr;gap:15px 23px;align-content:center;padding:20px 0}.live-orb{grid-row:1/3;width:142px;height:156px;display:grid;place-items:center;border-radius:47% 53% 44% 56%;background:radial-gradient(circle,#642837,#2c1d22 65%);box-shadow:0 0 0 1px #7e3b4b,7px 9px 0 #0b090a;transition:.3s;animation:creature 5s ease-in-out infinite}.live-orb.listening{background:radial-gradient(circle,#b33e51,#4b202b 67%);box-shadow:0 0 55px #df46554d,7px 9px 0 #0b090a}.live-orb.speaking{background:radial-gradient(circle,#d46148,#702b35 67%);box-shadow:0 0 62px #ef805e55,7px 9px 0 #0b090a}.live-orb.connecting{opacity:.55}.live-orb.error,.live-orb.completed{filter:saturate(.25);opacity:.7}.wave{height:54px;display:flex;align-items:center;gap:4px}.wave i{width:4px;height:18px;border-radius:8px;background:#f5d5b0;animation:wave 1.15s ease-in-out infinite}.wave i:nth-child(2),.wave i:nth-child(6){height:31px;animation-delay:.1s}.wave i:nth-child(3),.wave i:nth-child(5){height:43px;animation-delay:.2s}.wave i:nth-child(4){height:54px;animation-delay:.3s}.live-status{display:grid;align-content:end}.live-status small{color:#8f7b81;font-size:8px;letter-spacing:.15em}.live-status strong{margin-top:6px;color:#fff4e9;font:500 20px/1.1 Georgia,serif}.live-status span{margin-top:3px;color:#a9969b;font-size:11px}.lab-controls{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:8px}.lab-controls button{min-height:45px;padding:10px 12px;border:1px solid #58454b;border-radius:5px 13px 6px 10px;color:#e7dadd;background:#2b2024;font-weight:700;font-size:12px;transition:.18s}.lab-controls button:hover:not(:disabled){transform:translateY(-2px);border-color:#c56b78}.lab-controls .start{color:#fff8ef;border-color:#ff8e96;background:var(--red);box-shadow:4px 5px 0 #721f30}.lab-controls .close{grid-column:1/-1;min-height:36px;background:transparent}.lab-controls button:disabled{cursor:not-allowed;opacity:.28}.fixture{grid-column:2;position:relative;display:flex;align-items:center;gap:12px;padding:11px 13px;border:1px dashed #72535b;border-radius:14px 4px 12px 5px;color:#d9c9cc;background:#231a1e;cursor:pointer}.fixture input{position:absolute;inset:0;opacity:0;cursor:pointer}.fixture i{width:34px;height:34px;display:grid;place-items:center;flex:none;border-radius:50%;color:#211417;background:#f0ae78;font-style:normal;font-size:19px}.fixture span{display:grid}.fixture small{color:#9e898f;font-weight:400}.credit-note{grid-column:1/-1;margin:0;color:#b88b60;font-size:10px;text-align:right}@keyframes wave{50%{transform:scaleY(.38)}}@keyframes creature{0%,100%{border-radius:47% 53% 44% 56%;transform:rotate(-2deg)}45%{border-radius:54% 46% 57% 43%;transform:rotate(2deg) translateY(-3px)}75%{border-radius:43% 57% 48% 52%;transform:rotate(-4deg) translateY(2px)}}@media(max-width:1050px){.voice-lab{grid-template-columns:1fr}.lab-experience{grid-template-columns:140px 1fr}.fixture{grid-column:2}.credit-note{grid-column:1}}@media(max-width:680px){.voice-lab{padding:31px 21px 24px}.lab-experience{grid-template-columns:1fr;text-align:center}.live-orb{grid-row:auto;margin:auto}.live-status{text-align:center}.lab-controls{grid-template-columns:1fr}.lab-controls .close,.fixture{grid-column:1}.credit-note{text-align:left}}@media(prefers-reduced-motion:reduce){.live-orb,.wave i{animation:none!important}}
</style>

<style scoped>
.test-readiness{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;padding:12px 0 2px;border-top:1px solid #d0e0f3;color:#62779f;font-size:10px}.test-readiness span{padding:6px 8px;border-radius:999px;background:#edf6ff}.test-readiness .ready{color:#1d6b45;background:#e5f5e8}.test-readiness strong{color:inherit}
</style>

<style scoped>
/* Azul mineral: una conversación luminosa, no una consola tecnológica. */
.voice-lab{--red:#2354d7;--red2:#153b9f;--cream:#fff;--black:#10214d;color:#142655;border-color:#a9c9ef;border-radius:5px 42px 7px 24px;background:linear-gradient(108deg,#214fc8 0 41%,#ffffff 41%);box-shadow:0 24px 70px #1a4c9b20,9px 11px 0 #9ed0ff}.voice-lab:before{right:-105px;top:-178px;border-color:#79bdff;opacity:.6}.lab-copy{padding-right:10%}.lab-kicker{color:#bce0ff}.lab-kicker span{background:#fff}.lab-copy h2{color:#fff}.lab-copy h2 em{color:#acd7ff}.lab-copy>p{color:#cfdeff}.privacy span{color:#dce8ff;border-color:#ffffff42;background:#ffffff0d}.privacy .cost{color:#fff;border-color:#ffffff5c;background:#ffffff18}.live-orb{background:radial-gradient(circle,#4e87ee,#204fbf 67%);box-shadow:0 0 0 1px #9dcaff,7px 9px 0 #c6e3ff}.live-orb.listening{background:radial-gradient(circle,#7cbcff,#2356d1 68%);box-shadow:0 0 55px #5eaeff62,7px 9px 0 #c6e3ff}.live-orb.speaking{background:radial-gradient(circle,#ffffff,#71b4ff 54%,#2254cb 75%);box-shadow:0 0 62px #6eb8ff66,7px 9px 0 #c6e3ff}.wave i{background:#fff}.live-orb.speaking .wave i{background:#1746b8}.live-status small{color:#8698bd}.live-status strong{color:#122a68}.live-status span{color:#7182a6}.lab-controls button{color:#254071;border-color:#bfd3ee;background:#f1f7ff}.lab-controls button:hover:not(:disabled){border-color:#4f84df;background:#e7f2ff}.lab-controls .start{color:#fff;border-color:#1946ba;background:#2354d7;box-shadow:4px 5px 0 #aad4ff}.lab-controls .close{color:#5d719a;background:transparent}.fixture{color:#284171;border-color:#81afe5;background:#edf6ff}.fixture i{color:#fff;background:#2354d7}.fixture small{color:#7184a8}.credit-note{color:#6680ac}@media(max-width:1050px){.voice-lab{background:linear-gradient(155deg,#214fc8 0 37%,#fff 37%)}.lab-copy{padding:0 0 40px}}@media(max-width:680px){.voice-lab{background:#fff}.lab-copy{margin:-31px -21px 10px;padding:31px 21px 36px;background:#214fc8}.voice-lab:before{display:none}}
</style>

<style scoped>
.live-cost{grid-column:1/-1;margin-top:4px;padding:15px 17px;border:1px solid #b8d1ef;border-radius:8px 22px 8px 15px;background:linear-gradient(135deg,#f7fbff,#eaf4ff);box-shadow:4px 5px 0 #c7e3ff}.live-cost header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.live-cost header>span{display:grid;gap:3px}.live-cost header small{color:#7187ae;font-size:8px;font-weight:850;letter-spacing:.13em}.live-cost header strong{color:#153b91;font:500 30px/1 Georgia,serif}.live-cost header>b{display:flex;align-items:center;gap:6px;padding:5px 8px;color:#7789a8;border:1px solid #c6d7ed;border-radius:999px;font-size:8px;letter-spacing:.1em}.live-cost header>b i{width:6px;height:6px;border-radius:50%;background:#9caac0}.live-cost header>b.active{color:#167047;border-color:#a9d6bb;background:#e5f5ea}.live-cost header>b.active i{background:#24a568;box-shadow:0 0 0 4px #24a5681b}.cost-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-top:13px;border-block:1px solid #cedeef}.cost-metrics>span{display:grid;gap:3px;padding:10px 11px;border-right:1px solid #d7e5f3}.cost-metrics>span:last-child{border-right:0}.cost-metrics small{color:#7b8eae;font-size:8px;text-transform:uppercase;letter-spacing:.07em}.cost-metrics strong{color:#223d75;font-size:13px}.live-cost footer{display:flex;justify-content:space-between;gap:15px;padding-top:10px;color:#7c8eab;font-size:9px;line-height:1.35}.live-cost footer a{flex:none;color:#2354d7;font-weight:750;text-decoration:none}.live-cost footer a:hover{text-decoration:underline}@media(max-width:900px){.cost-metrics{grid-template-columns:repeat(2,1fr)}.cost-metrics>span{border-bottom:1px solid #d7e5f3}.cost-metrics>span:last-child{grid-column:1/-1}.live-cost footer{display:grid}}@media(max-width:680px){.live-cost{text-align:left}.cost-metrics{grid-template-columns:1fr 1fr}.live-cost header strong{font-size:26px}}
</style>
