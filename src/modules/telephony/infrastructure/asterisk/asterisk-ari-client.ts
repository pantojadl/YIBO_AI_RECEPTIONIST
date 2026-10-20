import { operationalLog } from "../../../../shared/observability/operational-log.js";
import WebSocket from "ws";
import type { AsteriskEvent, AsteriskMediaClient, ConnectableAsteriskClient } from "./asterisk-client.js";

export interface AsteriskAriClientOptions {
  baseUrl: string;
  application: string;
  username: string;
  password: string;
  logger?: (event: string, details?: Record<string, unknown>) => void;
}

/**
 * Thin, provider-bound ARI control client.  Media deliberately remains outside
 * this client so ARI identifiers never leak into scheduling or conversation code.
 */
export class AsteriskAriClient implements ConnectableAsteriskClient, AsteriskMediaClient {
  private readonly handlers: Array<(event: AsteriskEvent) => Promise<void>> = [];
  private readonly externalMediaChannelIds = new Set<string>();
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private closing = false;
  private readonly baseUrl: URL;
  private readonly log: (event: string, details?: Record<string, unknown>) => void;

  constructor(private readonly options: AsteriskAriClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!/^https?:$/.test(this.baseUrl.protocol)) throw new Error("ASTERISK_ARI_URL must use http or https");
    if (!options.application.trim() || !options.username.trim() || !options.password.trim()) {
      throw new Error("Asterisk ARI application, username, and password are required");
    }
    this.log = options.logger ?? operationalLog;
  }

  onEvent(handler: (event: AsteriskEvent) => Promise<void>): void { this.handlers.push(handler); }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.closing = false;
    this.connecting = this.openSocket();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  private async openSocket(): Promise<void> {
    this.log("telephony.ari.websocket_connecting", { application: this.options.application, host: this.baseUrl.host });
    const url = new URL("/ari/events", this.baseUrl);
    url.searchParams.set("app", this.options.application);
    url.searchParams.set("api_key", `${this.options.username}:${this.options.password}`);
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); socket.terminate(); reject(new Error("Asterisk ARI websocket connection timed out")); }, 10_000);
      const opened = () => { cleanup(); this.reconnectAttempt = 0; resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { clearTimeout(timeout); socket.off("open", opened); socket.off("error", failed); };
      socket.once("open", opened);
      socket.once("error", failed);
    });
    socket.on("message", (message) => this.onMessage(message.toString()));
    socket.on("close", () => { this.log("telephony.ari.disconnected"); if (this.socket === socket) this.socket = undefined; this.scheduleReconnect(); });
    socket.on("error", (error) => this.log("telephony.ari.error", { error: safeError(error) }));
    this.log("telephony.ari.connected", { application: this.options.application, host: this.baseUrl.host });
    this.log("telephony.ari.application_subscribed", { application: this.options.application });
  }

  close(): void { this.closing = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.socket?.close(); }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** this.reconnectAttempt++));
    this.log("telephony.ari.reconnect_scheduled", { durationMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        this.log("telephony.ari.reconnect_failed", { error: safeError(error) });
        this.scheduleReconnect();
      });
    }, delay);
  }
  async answer(channelId: string): Promise<void> { await this.request(`/ari/channels/${encodeURIComponent(channelId)}/answer`, { method: "POST" }); }
  async hangup(channelId: string): Promise<void> {
    try { await this.request(`/ari/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" }); }
    catch (error) { if (!isNotFound(error)) throw error; }
  }
  async transfer(channelId: string, target: { kind: "phone" | "extension"; value: string }): Promise<void> {
    // Phone targets go to a dialplan context that hangs up until a trunk is enabled.
    // PJSIP/<number> is not a carrier route and must not be dialed from this process.
    const endpoint = target.kind === "phone"
      ? `Local/${target.value.replace(/\D/g, "")}@yibo-outbound-transfer`
      : `Local/${target.value}@yibo-internal`;
    await this.request(`/ari/channels/${encodeURIComponent(channelId)}/redirect?endpoint=${encodeURIComponent(endpoint)}`, { method: "POST" });
  }

  async createMixingBridge(): Promise<{ bridgeId: string }> {
    const response = await this.requestJson("/ari/bridges?type=mixing", { method: "POST" });
    const bridgeId = typeof response.id === "string" ? response.id : undefined;
    if (!bridgeId) throw new Error("Asterisk ARI did not return a bridge id");
    return { bridgeId };
  }

  async addChannelsToBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    const channels = channelIds.map(encodeURIComponent).join(",");
    await this.request(`/ari/bridges/${encodeURIComponent(bridgeId)}/addChannel?channel=${channels}`, { method: "POST" });
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    try { await this.request(`/ari/bridges/${encodeURIComponent(bridgeId)}`, { method: "DELETE" }); }
    catch (error) { if (!isNotFound(error)) throw error; }
  }

  async createExternalMedia(input: { host: string; port: number; format: "ulaw"; direction: "both" }): Promise<{ channelId: string }> {
    const query = new URLSearchParams({
      app: this.options.application,
      external_host: `${input.host}:${input.port}`,
      format: input.format,
      direction: input.direction,
      appArgs: "yibo-external-media",
    });
    const response = await this.requestJson(`/ari/channels/externalMedia?${query.toString()}`, { method: "POST" });
    const channelId = typeof response.id === "string" ? response.id : undefined;
    if (!channelId) throw new Error("Asterisk ARI did not return an External Media channel id");
    this.externalMediaChannelIds.add(channelId);
    return { channelId };
  }

  private async request(path: string, init: RequestInit): Promise<void> {
    await this.requestResponse(path, init);
  }

  private async requestJson(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.requestResponse(path, init);
    return await response.json() as Record<string, unknown>;
  }

  private async requestResponse(path: string, init: RequestInit): Promise<Response> {
    const authorization = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")}`;
    // Keep the deadline active through response-body consumption as well.
    const response = await fetch(new URL(path, this.baseUrl), { ...init, headers: { authorization }, signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw Object.assign(new Error(`Asterisk ARI request failed (${response.status})`), { code: response.status === 404 ? "CHANNEL_NOT_FOUND" : "CONNECTION_UNAVAILABLE", retryable: response.status >= 500 });
    return response;
  }

  private onMessage(raw: string): void {
    let event: unknown;
    try { event = JSON.parse(raw); } catch { return; }
    if (!isRecord(event) || !isRecord(event.channel)) return;
    const channel = event.channel;
    const channelId = typeof channel.id === "string" ? channel.id : undefined;
    const occurredAt = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
    if (!channelId) return;
    if (event.type === "StasisStart") {
      const args = Array.isArray(event.args) ? event.args : [];
      const channelName = typeof channel.name === "string" ? channel.name : "unknown";
      const technology = channelTechnology(channelName);
      const externalMedia = this.externalMediaChannelIds.has(channelId)
        || args.includes("yibo-external-media")
        || isExternalMediaChannelName(channelName);
      this.log("telephony.ari.stasis_start", {
        channelId,
        channelName,
        channelTechnology: technology,
        args: safeArgs(args),
        channelType: externalMedia ? "external_media" : "caller",
      });
      if (externalMedia) {
        this.log("telephony.ari.external_media_stasis_ignored", { channelId, channelName, channelTechnology: technology });
        return;
      }
      const caller = channel.caller as Record<string, unknown> | undefined;
      const dialplan = channel.dialplan as Record<string, unknown> | undefined;
      const calledNumber = typeof args[0] === "string" && args[0] !== "yibo-external-media"
        ? args[0]
        : String(dialplan?.exten ?? "unknown");
      const value: AsteriskEvent = { type: "CHANNEL_ENTERED_APPLICATION", channelId, callerNumber: String(caller?.number ?? "unknown"), dialedNumber: calledNumber, occurredAt };
      void this.emit(value);
    } else if (event.type === "StasisEnd" || event.type === "ChannelDestroyed") {
      this.externalMediaChannelIds.delete(channelId);
      this.log(event.type === "StasisEnd" ? "telephony.ari.stasis_end" : "telephony.ari.channel_destroyed", { channelId });
      void this.emit({ type: "CHANNEL_DESTROYED", channelId, occurredAt });
    } else if (event.type === "ChannelDtmfReceived" && typeof event.digit === "string") {
      void this.emit({ type: "DTMF_RECEIVED", channelId, digit: event.digit, occurredAt });
    }
  }

  private async emit(event: AsteriskEvent): Promise<void> { await Promise.all(this.handlers.map((handler) => handler(event))); }
}

const safeError = (value: unknown) => (value instanceof Error ? value.message : "Unexpected ARI socket error").replace(/(api_key=|Authorization:).*$/i, "[redacted]").slice(0, 300);
const isNotFound = (value: unknown) => typeof value === "object" && value !== null && (value as { code?: string }).code === "CHANNEL_NOT_FOUND";
const channelTechnology = (name: string): string => name.split("/", 1)[0] || "unknown";
const isExternalMediaChannelName = (name: string): boolean => channelTechnology(name).toLowerCase() === "unicastrtp";
const safeArgs = (args: unknown[]): string[] => args.filter((arg): arg is string => typeof arg === "string").map((arg) => arg.slice(0, 80));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
