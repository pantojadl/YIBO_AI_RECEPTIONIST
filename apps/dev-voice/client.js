import { VoiceLabSession } from "./voice-lab-session.js";
const log = document.querySelector("#log");
const micButton = document.querySelector("#mic");
const stopButton = document.querySelector("#stop");
const closeButton = document.querySelector("#close");
const interruptButton = document.querySelector("#interrupt");
const wavInput = document.querySelector("#wav");
const voiceOrb = document.querySelector("#voiceOrb");
const orbStatus = document.querySelector("#orbStatus");
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const lab = new VoiceLabSession({
  url: `${protocol}//${location.host}/voice`,
  onActivity: event => line(JSON.stringify(event)),
  onState: state => {
    const active = state.phase === "starting" || state.phase === "active";
    micButton.disabled = state.microphoneActive || ["connecting", "starting"].includes(state.phase);
    stopButton.disabled = !state.microphoneActive;
    closeButton.disabled = interruptButton.disabled = !active;
    wavInput.disabled = micButton.disabled;
    micButton.textContent = active ? "Reanudar micrófono" : state.testNumber ? "Iniciar otra prueba" : "Iniciar prueba";
    const copy = {
      connecting: ["Conectando…", "Preparando el canal de audio"],
      ready: ["En espera", "Lista para comenzar"],
      starting: ["Iniciando prueba…", "Preparando micrófono y conversación"],
      active: ["Prueba activa", "El micrófono está pausado"],
      completed: ["Prueba terminada", "Puedes iniciar otra prueba; el historial se conserva"],
      error: ["Prueba interrumpida", "Revisa la actividad e intenta de nuevo"],
    };
    const visual = state.speaking ? "speaking" : state.microphoneActive ? "listening" : state.phase;
    const [title, detail] = state.speaking ? ["YIBO está hablando", "Puedes interrumpir su respuesta"]
      : state.microphoneActive ? ["Escuchando", "Habla con naturalidad"] : copy[state.phase];
    setOrb(visual, title, detail);
  },
});
micButton.addEventListener("click", () => void lab.startMicrophone());
stopButton.addEventListener("click", () => lab.pauseMicrophone());
interruptButton.addEventListener("click", () => lab.interrupt());
closeButton.addEventListener("click", () => lab.finish());
wavInput.addEventListener("change", async ({ target }) => {
  const file = target.files?.[0];
  if (file) await lab.sendFixture(file);
  target.value = "";
});
window.addEventListener("pagehide", () => lab.dispose(), { once: true });
void lab.connect().catch(() => {});

function line(value) {
  const following = log.scrollHeight - log.clientHeight - log.scrollTop <= 32;
  log.textContent += `${value}\n`;
  if (following) log.scrollTop = log.scrollHeight;
}

function setOrb(state, title, detail) {
  voiceOrb.classList.remove("listening", "speaking", "connecting");
  if (["listening", "speaking", "connecting"].includes(state)) voiceOrb.classList.add(state);
  orbStatus.replaceChildren(Object.assign(document.createElement("b"), { textContent: title }), document.createTextNode(detail));
}
