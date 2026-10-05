import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { GoogleCalendarAccessStatus, GoogleIntegrationStatus, GoogleToken, GoogleTokenStore } from "./contracts.js";

export interface GoogleOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  stateSigningKey?: string;
}

type AuthorizationState = { tenantId: string; returnTo: string; expiresAt: number; nonce: string };

export class GoogleOAuthService {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly tokens: GoogleTokenStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async status(tenantId: string): Promise<GoogleIntegrationStatus> {
    const configured = this.isConfigured();
    if (!configured) return { configured: false, connected: false };
    try {
      return { configured: true, connected: (await this.accessToken(tenantId)) !== null };
    } catch {
      return { configured: true, connected: false };
    }
  }

  authorizationUrl(tenantId: string, returnTo: string): string | null {
    if (!this.isConfigured()) return null;
    const state = this.signState({ tenantId, returnTo, expiresAt: Date.now() + 10 * 60_000, nonce: randomUUID() });
    const query = new URLSearchParams({
      client_id: this.config.clientId!, redirect_uri: this.config.redirectUri!, response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy",
      access_type: "offline", prompt: "consent", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
  }

  async completeAuthorization(code: string, state: string): Promise<{ tenantId: string; returnTo: string } | null> {
    const pending = this.readState(state);
    if (!pending || !code || !this.isConfigured()) return null;

    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: this.config.clientId!, client_secret: this.config.clientSecret!,
        redirect_uri: this.config.redirectUri!, grant_type: "authorization_code",
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!payload.access_token || !payload.refresh_token) return null;
    await this.tokens.save(pending.tenantId, {
      accessToken: payload.access_token, refreshToken: payload.refresh_token,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
    });
    return { tenantId: pending.tenantId, returnTo: pending.returnTo };
  }

  returnToForState(state: string): string | null {
    return this.readState(state)?.returnTo ?? null;
  }

  async accessToken(tenantId: string): Promise<string | null> {
    const current = await this.tokens.get(tenantId);
    if (!current) return null;
    if (new Date(current.expiresAt).valueOf() > Date.now() + 60_000) return current.accessToken;
    if (!current.refreshToken || !this.isConfigured()) return null;

    let response: Response;
    try {
      response = await this.fetcher("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId!, client_secret: this.config.clientSecret!,
          refresh_token: current.refreshToken, grant_type: "refresh_token",
        }),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) return null;
    const refreshed: GoogleToken = {
      accessToken: payload.access_token, refreshToken: current.refreshToken,
      expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
    };
    await this.tokens.save(tenantId, refreshed);
    return refreshed.accessToken;
  }

  async verifyCalendarAccess(tenantId: string, calendarId: string): Promise<GoogleCalendarAccessStatus> {
    if (!this.isConfigured()) return "integration_not_configured";
    const token = await this.accessToken(tenantId);
    if (!token) return "disconnected";
    try {
      // Use the calendar.events scope we request; calendar metadata needs a
      // different scope. Return only the collection kind, never event details.
      const response = await this.fetcher(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=1&fields=kind`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (response.ok) return "accessible";
      if (response.status === 403) {
        const payload = await response.json().catch(() => null) as {
          error?: { errors?: Array<{ reason?: string }> };
        } | null;
        return payload?.error?.errors?.some(({ reason }) => reason === "accessNotConfigured")
          ? "api_not_enabled"
          : "forbidden";
      }
      if (response.status === 404) return "not_found";
      if (response.status === 401) return "disconnected";
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri && this.config.stateSigningKey);
  }

  private signState(value: AuthorizationState): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  private readState(value: string): AuthorizationState | null {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !this.config.stateSigningKey) return null;
    const expected = this.signature(payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthorizationState;
      return state.tenantId && isLocalDashboardUrl(state.returnTo) && state.expiresAt > Date.now() ? state : null;
    } catch { return null; }
  }

  private signature(payload: string): string {
    return createHmac("sha256", this.config.stateSigningKey!).update(payload).digest("base64url");
  }
}

const isLocalDashboardUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && Boolean(url.port);
  } catch { return false; }
};
