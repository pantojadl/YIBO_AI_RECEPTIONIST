/** Shared by the dashboard Test screen and the standalone Voice Lab. */
export class VoiceLabSession {
  constructor(options) {
    this.options = options;
    this.state = { phase: "connecting", connected: false, microphoneActive: false,
      speaking: false, aiConnected: false, testNumber: 0 };
    this.disposed = false;
  }

  publish(patch) {
    Object.assign(this.state, patch);
    if (!this.disposed) this.options.onState({ ...this.state });
  }

  log(event, metadata = {}) {
    if (!this.disposed) this.options.onActivity({ event, callId: this.state.callId,
      testNumber: this.state.testNumber, timestamp: new Date().toISOString(), ...metadata });
  }

  current(run) { return !this.disposed && this.run === run && !run.ended; }

  connect() {
    if (this.disposed) return Promise.resolve();
    if (this.run && !this.run.ended) return this.run.ready;
    const run = { ended: false, used: false, micVersion: 0, playbackVersion: 0,
      nodes: new Set(), turns: new Map(), playbackAt: 0, chain: Promise.resolve(), listeners: [] };
    this.run = run;
    run.ready = new Promise((resolve, reject) => { run.resolve = resolve; run.reject = reject; });
    // A connection can be disposed before anyone awaits readiness.
    void run.ready.catch(() => {});
    this.publish({ phase: "connecting", connected: false, aiConnected: false,
      microphoneActive: false, speaking: false, callId: undefined,
      configuration: undefined, completionReason: undefined });
    try {
      run.socket = (this.options.createSocket ?? (url => new WebSocket(url)))(this.options.url);
      run.socket.binaryType = "arraybuffer";
      const listen = (name, handler) => {
        run.socket.addEventListener(name, handler);
        run.listeners.push([name, handler]);
      };
      listen("open", () => { if (this.current(run)) this.log("harness.connected"); });
      listen("message", ({ data }) => { if (this.current(run)) this.receive(run, data); });
      listen("close", () => this.finalize(run, "disconnected", true, false));
      listen("error", () => this.finalize(run, "connection_failed", true, false));
      run.connectTimer = setTimeout(() => this.finalize(run, "connection_timeout", true), 10_000);
    } catch (error) {
      this.log("error", { error: error.message });
      this.finalize(run, "connection_failed", true, false);
    }
    return run.ready;
  }

  async prepare() {
    if (this.disposed) return;
    const ready = this.connect();
    const run = this.run;
    await ready;
    if (!this.current(run)) return;
    const blocked = this.options.blockReason?.(this.state.configuration);
    if (blocked) { this.log("error", { error: blocked }); return; }
    if (!run.used) {
      run.used = true;
      this.publish({ testNumber: this.state.testNumber + 1, phase: "starting" });
      this.log("test.started");
    }
    return run;
  }

  async audioContext(run) {
    if (!this.current(run)) return;
    run.context ??= (this.options.createAudioContext ?? (() => new AudioContext()))();
    const context = run.context;
    if (context.state !== "running") await context.resume();
    if (!this.current(run)) return;
    if (context.state !== "running") throw new Error(`Browser audio is ${context.state}`);
    return context;
  }

  async startMicrophone() {
    let run;
    try {
      run = await this.prepare();
      if (!run || run.stream || run.micPending) return;
      run.micPending = true;
      const version = ++run.micVersion;
      const context = await this.audioContext(run);
      if (!context || !this.current(run) || version !== run.micVersion) return;
      const stream = await (this.options.getUserMedia ?? (() => navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 }, video: false,
      })))();
      if (!this.current(run) || version !== run.micVersion) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      run.stream = stream;
      run.source = context.createMediaStreamSource(stream);
      run.processor = context.createScriptProcessor(2048, 1, 1);
      run.processor.onaudioprocess = ({ inputBuffer }) => {
        if (this.current(run) && run.socket.readyState === 1) {
          run.socket.send(inputBuffer.getChannelData(0).slice().buffer);
        }
      };
      run.source.connect(run.processor);
      run.processor.connect(context.destination);
      this.send(run, { type: "mic.start", sampleRate: context.sampleRate, channels: 1 });
      this.publish({ microphoneActive: true });
      this.log("microphone.enabled");
    } catch (error) {
      if (run && this.current(run)) {
        this.log("error", { error: error.message });
        this.finalize(run, "microphone_failed", true);
      }
    } finally { if (run) run.micPending = false; }
  }

  stopMicrophone(run) {
    ++run.micVersion;
    if (run.processor) run.processor.onaudioprocess = null;
    run.processor?.disconnect();
    run.source?.disconnect();
    run.stream?.getTracks().forEach(track => track.stop());
    run.processor = run.source = run.stream = undefined;
    run.micPending = false;
  }

  pauseMicrophone() {
    const run = this.run;
    if (!run || !this.current(run)) return;
    this.stopMicrophone(run);
    this.publish({ microphoneActive: false });
    this.log("microphone.paused");
  }

  async sendFixture(file) {
    let run;
    try {
      run = await this.prepare();
      if (!run) return;
      if (!await this.audioContext(run)) return;
      const bytes = await file.arrayBuffer();
      if (!this.current(run)) return;
      this.send(run, { type: "fixture.next", name: file.name });
      run.socket.send(bytes);
      this.log("fixture.sent", { name: file.name });
    } catch (error) {
      if (run && this.current(run)) {
        this.log("error", { error: error.message });
        this.finalize(run, "fixture_failed", true);
      }
    }
  }

  interrupt() {
    if (this.run?.used && this.current(this.run)) this.send(this.run, { type: "interrupt" });
  }

  finish() { if (this.run) this.finalize(this.run, "manual"); }

  dispose() {
    if (this.run) this.finalize(this.run, "unmounted");
    this.disposed = true;
  }

  finalize(run, reason, failed = false, notify = true) {
    if (!this.current(run)) return;
    // Mark terminal before stopping nodes/sockets: their callbacks can run synchronously.
    run.ended = true;
    if (notify && run.used) this.send(run, { type: "close" });
    clearTimeout(run.connectTimer);
    run.reject(new Error("Voice test ended"));
    this.stopMicrophone(run);
    this.stopPlayback(run);
    run.pendingAudio = undefined;
    run.chain = Promise.resolve();
    for (const [name, handler] of run.listeners) run.socket.removeEventListener(name, handler);
    run.listeners = [];
    if (run.socket && run.socket.readyState < 2) run.socket.close();
    const context = run.context;
    run.context = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    this.publish({ phase: failed ? "error" : "completed", completionReason: reason,
      connected: false, microphoneActive: false, speaking: false, aiConnected: false });
    this.log("test.completed", { reason, failed });
  }

  send(run, message) {
    if (run.socket?.readyState === 1) run.socket.send(JSON.stringify(message));
  }

  receive(run, data) {
    if (typeof data !== "string") {
      const metadata = run.pendingAudio;
      const version = run.playbackVersion;
      run.pendingAudio = undefined;
      run.chain = run.chain.then(() => this.play(run, data, metadata, version)).catch(error => {
        if (this.current(run)) {
          this.log("error", { error: error.message });
          this.finalize(run, "audio_failed", true);
        }
      });
      return;
    }
    let message;
    try { message = JSON.parse(data); }
    catch { this.finalize(run, "invalid_message", true); return; }
    if (!message || typeof message !== "object") { this.finalize(run, "invalid_message", true); return; }
    if (message.type === "voice.lab.ready") {
      clearTimeout(run.connectTimer);
      this.publish({ phase: "ready", connected: true, configuration: message, callId: message.callId });
      run.resolve();
    } else if (message.type === "audio.chunk") {
      run.pendingAudio = message;
      if (message.assistantTurnId !== run.announcedTurn) {
        run.announcedTurn = message.assistantTurnId;
        this.log("assistant.audio_received");
      }
    } else if (message.type === "playback.clear") {
      const now = run.context?.currentTime ?? 0;
      const current = [...run.turns.values()].find(turn => turn.startedAt <= now) ?? run.turns.values().next().value;
      this.stopPlayback(run);
      this.publish({ speaking: false });
      this.send(run, { type: "playback.cleared", requestId: message.requestId, active: Boolean(current),
        assistantTurnId: current?.id, audioEndMs: current ? Math.max(0, Math.round((now - current.startedAt) * 1000)) : 0 });
      this.log("playback.cleared");
    } else if (message.type === "playback.finish") {
      const version = run.playbackVersion;
      void run.chain.then(() => {
        if (!this.current(run) || version !== run.playbackVersion) return;
        run.drain = message;
        this.reportIdle(run);
      });
    } else {
      this.log(message.event ?? message.type ?? "activity", message);
      const name = message.event ?? message.type;
      if (name === "conversation.opened") this.publish({ phase: "active", aiConnected: true });
      if (name === "conversation.closed" || name === "closed") {
        this.finalize(run, message.reason ?? "conversation_ended", message.failed === true, false);
      }
    }
  }

  async play(run, bytes, metadata, version) {
    if (!metadata?.assistantTurnId || !this.current(run) || version !== run.playbackVersion) return;
    const context = await this.audioContext(run);
    if (!context || version !== run.playbackVersion) return;
    const pcm = new Int16Array(bytes);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, 24_000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    run.playbackAt = Math.max(run.playbackAt, context.currentTime + 0.02);
    let turn = run.turns.get(metadata.assistantTurnId);
    if (!turn) {
      turn = { id: metadata.assistantTurnId, startedAt: run.playbackAt, nodes: new Set() };
      run.turns.set(turn.id, turn);
    }
    turn.nodes.add(node);
    run.nodes.add(node);
    node.onended = () => {
      if (!this.current(run) || version !== run.playbackVersion) return;
      node.disconnect();
      run.nodes.delete(node);
      turn.nodes.delete(node);
      if (!turn.nodes.size) run.turns.delete(turn.id);
      if (!run.nodes.size) this.publish({ speaking: false });
      this.reportIdle(run);
    };
    node.start(run.playbackAt);
    run.playbackAt += buffer.duration;
    this.publish({ speaking: true });
  }

  reportIdle(run) {
    if (!run.drain || run.nodes.size || !this.current(run)) return;
    this.send(run, { type: "playback.idle", requestId: run.drain.requestId, assistantTurnId: run.drain.assistantTurnId });
    run.drain = undefined;
  }

  stopPlayback(run) {
    ++run.playbackVersion;
    for (const node of run.nodes) {
      node.onended = null;
      try { node.stop(); } catch { /* Already played. */ }
      node.disconnect();
    }
    run.nodes.clear();
    run.turns.clear();
    run.drain = run.pendingAudio = undefined;
    run.playbackAt = 0;
  }
}
