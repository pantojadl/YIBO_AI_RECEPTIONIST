import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  LOCK_HEARTBEAT_MS,
  LOCK_LEASE_MS,
  leaseIsExpired,
  runWithAppointmentFence,
} from "../../modules/appointments/application/appointment-lock.js";
import { AppointmentOperationInProgressError, type AppointmentConcurrencyGuard, type AppointmentLockClaim } from "../../modules/appointments/index.js";
import type { RegionId } from "../../shared/types/identifiers.js";

/**
 * One numeric clock owns lease math. A second writer may take the claim only
 * after heartbeats stop. The steal increments the fence. Release deletes only
 * the owner and fence that entered this call.
 */
export class SqliteAppointmentConcurrencyGuard implements AppointmentConcurrencyGuard {
  private readonly stolen = new Set<string>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly region: RegionId,
    private readonly options: { now?: () => number; leaseMs?: number; heartbeatMs?: number } = {},
  ) {}

  async execute<T>(tenantId: string, locationId: string, _employeeId: string, operation: () => Promise<T>): Promise<T> {
    const ownerId = randomUUID();
    const now = this.now();
    const inserted = this.database.prepare(`INSERT INTO appointment_operation_locks
      (region_id, tenant_id, location_id, owner_id, owner_pid, acquired_at, fence, heartbeat_ms)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(region_id, tenant_id, location_id) DO NOTHING`)
      .run(this.region, tenantId, locationId, ownerId, process.pid, new Date(now).toISOString(), now);
    let fence = 1;
    if (inserted.changes !== 1) {
      const stolen = this.database.prepare(`UPDATE appointment_operation_locks
        SET owner_id = ?, owner_pid = ?, acquired_at = ?, fence = fence + 1, heartbeat_ms = ?
        WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND heartbeat_ms <= ?`)
        .run(ownerId, process.pid, new Date(now).toISOString(), now, this.region, tenantId, locationId, now - this.leaseMs());
      if (stolen.changes !== 1) throw new AppointmentOperationInProgressError();
      this.stolen.add(`${tenantId}:${locationId}`);
      const row = this.database.prepare(`SELECT fence FROM appointment_operation_locks
        WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND owner_id = ?`)
        .get(this.region, tenantId, locationId, ownerId) as { fence: number };
      fence = row.fence;
    }
    const heartbeat = setInterval(() => {
      try { this.heartbeat(tenantId, locationId, ownerId, fence); } catch { /* The database may be closing. */ }
    }, this.options.heartbeatMs ?? LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await runWithAppointmentFence({ ownerId, fence }, () => operation());
    } finally {
      clearInterval(heartbeat);
      this.database.prepare(`DELETE FROM appointment_operation_locks
        WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND owner_id = ? AND fence = ?`)
        .run(this.region, tenantId, locationId, ownerId, fence);
    }
  }

  heartbeat(tenantId: string, locationId: string, ownerId: string, fence: number): boolean {
    const result = this.database.prepare(`UPDATE appointment_operation_locks SET heartbeat_ms = ?
      WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND owner_id = ? AND fence = ?`)
      .run(this.now(), this.region, tenantId, locationId, ownerId, fence);
    return result.changes === 1;
  }

  ownsFence(tenantId: string, locationId: string, ownerId: string, fence: number): boolean {
    const row = this.database.prepare(`SELECT 1 AS found FROM appointment_operation_locks
      WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND owner_id = ? AND fence = ?`)
      .get(this.region, tenantId, locationId, ownerId, fence) as { found: number } | undefined;
    return row?.found === 1;
  }

  hasLiveLease(tenantId: string, locationId: string): boolean {
    const row = this.database.prepare(`SELECT heartbeat_ms FROM appointment_operation_locks
      WHERE region_id = ? AND tenant_id = ? AND location_id = ?`)
      .get(this.region, tenantId, locationId) as { heartbeat_ms: number } | undefined;
    return row !== undefined && !leaseIsExpired(row.heartbeat_ms, this.now(), this.leaseMs());
  }

  hasUnresolvedSteal(tenantId: string, locationId: string): boolean {
    return this.stolen.has(`${tenantId}:${locationId}`);
  }

  clearSteal(tenantId: string, locationId: string): void {
    this.stolen.delete(`${tenantId}:${locationId}`);
  }

  listClaims(tenantId: string): AppointmentLockClaim[] {
    return this.database.prepare(`SELECT tenant_id, location_id, owner_id, owner_pid, acquired_at, fence, heartbeat_ms
      FROM appointment_operation_locks WHERE region_id = ? AND tenant_id = ?`)
      .all(this.region, tenantId)
      .map((row) => {
        const value = row as {
          tenant_id: string; location_id: string; owner_id: string; owner_pid: number;
          acquired_at: string; fence: number; heartbeat_ms: number;
        };
        return {
          tenantId: value.tenant_id, locationId: value.location_id, ownerId: value.owner_id,
          ownerPid: value.owner_pid, acquiredAt: value.acquired_at, fence: value.fence, heartbeatMs: value.heartbeat_ms,
        };
      });
  }

  releaseClaim(tenantId: string, locationId: string, ownerId: string, _acquiredAt: string): boolean {
    const claim = this.listClaims(tenantId).find((item) => item.locationId === locationId && item.ownerId === ownerId);
    if (!claim || claim.fence === undefined || claim.heartbeatMs === undefined) return false;
    if (!leaseIsExpired(claim.heartbeatMs, this.now(), this.leaseMs())) return false;
    const result = this.database.prepare(`DELETE FROM appointment_operation_locks
      WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND owner_id = ? AND fence = ? AND heartbeat_ms = ?`)
      .run(this.region, tenantId, locationId, ownerId, claim.fence, claim.heartbeatMs);
    return result.changes === 1;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private leaseMs(): number {
    return this.options.leaseMs ?? LOCK_LEASE_MS;
  }
}
