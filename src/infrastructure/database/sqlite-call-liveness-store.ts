import type { DatabaseSync } from "node:sqlite";
import type { CallLivenessStore } from "../../modules/calls/application/call-liveness.js";

/** Hangup marks in the regional database, visible to every process that opens it. */
export class SqliteCallLivenessStore implements CallLivenessStore {
  constructor(private readonly database: DatabaseSync) {}

  markEnded(callId: string, endedAtMs: number, ttlMs: number): void {
    if (!callId) return;
    const expiresAtMs = endedAtMs + ttlMs;
    this.database.prepare("DELETE FROM ended_calls WHERE ended_at_ms > 0 AND expires_at_ms <= ? AND in_flight = 0").run(endedAtMs);
    this.database.prepare(`
      INSERT INTO ended_calls(call_id, ended_at_ms, expires_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET
        ended_at_ms = excluded.ended_at_ms,
        expires_at_ms = excluded.expires_at_ms
      WHERE excluded.expires_at_ms > ended_calls.expires_at_ms OR ended_calls.ended_at_ms = 0
    `).run(callId, endedAtMs, expiresAtMs);
  }

  isEnded(callId: string, nowMs: number): boolean {
    this.database.prepare("DELETE FROM ended_calls WHERE ended_at_ms > 0 AND expires_at_ms <= ? AND in_flight = 0").run(nowMs);
    const row = this.database.prepare(`SELECT ended_at_ms AS endedAt, expires_at_ms AS expiresAt, in_flight AS inFlight
      FROM ended_calls WHERE call_id = ?`).get(callId) as { endedAt: number; expiresAt: number; inFlight: number } | undefined;
    if (!row || row.endedAt <= 0) return false;
    return row.expiresAt > nowMs || row.inFlight > 0;
  }

  pin(callId: string): void {
    if (!callId) return;
    this.database.prepare(`INSERT INTO ended_calls(call_id, ended_at_ms, expires_at_ms, in_flight) VALUES (?, 0, 0, 1)
      ON CONFLICT(call_id) DO UPDATE SET in_flight = ended_calls.in_flight + 1`).run(callId);
  }

  unpin(callId: string): void {
    if (!callId) return;
    this.database.prepare("UPDATE ended_calls SET in_flight = in_flight - 1 WHERE call_id = ? AND in_flight > 0").run(callId);
    this.database.prepare("DELETE FROM ended_calls WHERE call_id = ? AND in_flight <= 0 AND ended_at_ms = 0").run(callId);
  }

  reset(): void {
    this.database.prepare("DELETE FROM ended_calls").run();
  }
}
