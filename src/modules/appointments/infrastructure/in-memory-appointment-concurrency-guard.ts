import { randomUUID } from "node:crypto";
import type { EmployeeId, LocationId, TenantId } from "../../../shared/types/identifiers.js";
import { runWithAppointmentFence } from "../application/appointment-lock.js";
import type { AppointmentConcurrencyGuard, AppointmentLockClaim } from "../ports/appointment-dependencies.js";

export class InMemoryAppointmentConcurrencyGuard implements AppointmentConcurrencyGuard {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly claims = new Map<string, AppointmentLockClaim & { live: boolean }>();
  private readonly fences = new Map<string, number>();

  async execute<T>(tenantId: TenantId, locationId: LocationId, _employeeId: EmployeeId, operation: () => Promise<T>): Promise<T> {
    // Location-wide serialization protects both the professional's capacity 1
    // and the shared location capacity when different professionals race.
    const key = `${tenantId}:${locationId}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const ownerId = randomUUID();
    this.tails.set(key, current);
    await previous;
    const fence = (this.fences.get(key) ?? 0) + 1;
    this.fences.set(key, fence);
    this.claims.set(key, {
      tenantId, locationId, ownerId, ownerPid: process.pid, acquiredAt: new Date().toISOString(),
      fence, heartbeatMs: Date.now(), live: true,
    });
    try {
      return await runWithAppointmentFence({ ownerId, fence }, () => operation());
    } finally {
      const claim = this.claims.get(key);
      if (claim?.ownerId === ownerId && claim.fence === fence) this.claims.delete(key);
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }

  heartbeat(tenantId: TenantId, locationId: LocationId, ownerId: string, fence: number): boolean {
    const claim = this.claims.get(`${tenantId}:${locationId}`);
    if (!claim || claim.ownerId !== ownerId || claim.fence !== fence) return false;
    claim.heartbeatMs = Date.now();
    return true;
  }

  ownsFence(tenantId: TenantId, locationId: LocationId, ownerId: string, fence: number): boolean {
    const claim = this.claims.get(`${tenantId}:${locationId}`);
    return Boolean(claim?.live && claim.ownerId === ownerId && claim.fence === fence);
  }

  hasLiveLease(tenantId: TenantId, locationId: LocationId): boolean {
    return Boolean(this.claims.get(`${tenantId}:${locationId}`)?.live);
  }

  hasUnresolvedSteal(_tenantId: TenantId, _locationId: LocationId): boolean {
    return false;
  }

  clearSteal(_tenantId: TenantId, _locationId: LocationId): void {}

  listClaims(tenantId: TenantId): AppointmentLockClaim[] {
    return [...this.claims.values()]
      .filter((claim) => claim.tenantId === tenantId)
      .map(({ tenantId: claimTenant, locationId, ownerId, ownerPid, acquiredAt, fence, heartbeatMs }) => ({
        tenantId: claimTenant, locationId, ownerId, ownerPid, acquiredAt, fence, heartbeatMs,
      }));
  }

  releaseClaim(tenantId: TenantId, locationId: LocationId, ownerId: string, acquiredAt: string): boolean {
    const key = `${tenantId}:${locationId}`;
    const claim = this.claims.get(key);
    if (!claim || claim.live || claim.ownerId !== ownerId || claim.acquiredAt !== acquiredAt) return false;
    this.claims.delete(key);
    return true;
  }
}
