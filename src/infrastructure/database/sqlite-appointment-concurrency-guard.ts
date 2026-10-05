import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppointmentOperationInProgressError, type AppointmentConcurrencyGuard } from "../../modules/appointments/index.js";
import type { RegionId } from "../../shared/types/identifiers.js";

/** No transaction spans a provider call. The committed claim prevents another
 * process from validating or mutating capacity at this location until release. */
export class SqliteAppointmentConcurrencyGuard implements AppointmentConcurrencyGuard {
  constructor(private readonly database: DatabaseSync, private readonly region: RegionId) {}

  async execute<T>(tenantId: string, locationId: string, _employeeId: string, operation: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const claim = this.database.prepare(`INSERT INTO appointment_operation_locks
      (region_id, tenant_id, location_id, owner_id, owner_pid, acquired_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(region_id, tenant_id, location_id) DO NOTHING`)
      .run(this.region, tenantId, locationId, owner, process.pid, new Date().toISOString());
    if (claim.changes !== 1) throw new AppointmentOperationInProgressError();
    try { return await operation(); }
    finally {
      this.database.prepare(`DELETE FROM appointment_operation_locks
        WHERE region_id = ? AND tenant_id = ? AND location_id = ? AND owner_id = ?`)
        .run(this.region, tenantId, locationId, owner);
    }
  }
}
