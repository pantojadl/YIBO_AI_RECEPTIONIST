import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { VersionedBusinessProfile } from "../../modules/business/index.js";
import type { RegionId } from "../../shared/types/identifiers.js";

const migrations = [
  { version: 1, path: fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url)) },
  { version: 2, path: fileURLToPath(new URL("./migrations/002_agent_configuration_and_usage.sql", import.meta.url)) },
  { version: 3, path: fileURLToPath(new URL("./migrations/003_call_history.sql", import.meta.url)) },
  { version: 4, path: fileURLToPath(new URL("./migrations/004_google_calendar_tokens.sql", import.meta.url)) },
  { version: 5, path: fileURLToPath(new URL("./migrations/005_admin_users.sql", import.meta.url)) },
  { version: 6, path: fileURLToPath(new URL("./migrations/006_admin_audit_log.sql", import.meta.url)) },
  { version: 7, path: fileURLToPath(new URL("./migrations/007_location_context.sql", import.meta.url)) },
  { version: 8, path: fileURLToPath(new URL("./migrations/008_business_configuration_version.sql", import.meta.url)) },
  { version: 9, path: fileURLToPath(new URL("./migrations/009_appointment_price_snapshot.sql", import.meta.url)) },
  { version: 10, path: fileURLToPath(new URL("./migrations/010_office_operations.sql", import.meta.url)) },
  { version: 11, path: fileURLToPath(new URL("./migrations/011_appointment_edit_protection.sql", import.meta.url)) },
];

export const defaultDatabasePath = (region: RegionId): string =>
  process.env[`YIBO_DATABASE_${region}`] ?? resolve(process.cwd(), "data", `yibo-${region.toLowerCase()}.sqlite`);

export function openRegionalDatabase(region: RegionId, path = defaultDatabasePath(region)): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  // These settings belong to this connection, so every API/voice connection needs them.
  // Set the timeout first: changing journal mode can briefly need an exclusive lock.
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA foreign_keys = ON;");

  // journal_mode is database-wide. Re-applying WAL from every process races while
  // SQLite upgrades its lock, so only request the change when the file is not yet
  // in WAL mode. A simultaneous first startup is retried below.
  const currentMode = String(
    (database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode ?? "",
  ).toLowerCase();
  if (currentMode !== "wal") {
    withSqliteBusyRetry(() => database.prepare("PRAGMA journal_mode = WAL").get());
  }
  return database;
}

export function migrateDatabase(database: DatabaseSync): void {
  withWriteTransaction(database, () => {
    database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    for (const migration of migrations) {
      const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.version);
      if (applied) continue;
      database.exec(readFileSync(migration.path, "utf8"));
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
  });
}

export function seedBusiness(database: DatabaseSync, profile: VersionedBusinessProfile): void {
  withWriteTransaction(database, () => {
    database.prepare(`
      INSERT INTO businesses(region_id, tenant_id, business_id, profile_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(region_id, tenant_id) DO NOTHING
    `).run(profile.region, profile.tenantId, profile.businessId, JSON.stringify(profile));
    const insertNumber = database.prepare(
      "INSERT OR IGNORE INTO called_numbers(region_id, tenant_id, location_id, phone) VALUES (?, ?, ?, ?)",
    );
    const assignments = profile.schemaVersion === 2
      ? profile.locations.flatMap((location) => location.calledNumbers.map((phone) => ({ phone, locationId: location.id })))
      : profile.calledNumbers.map((phone) => ({ phone, locationId: "default" }));
    for (const { phone, locationId } of assignments) {
      insertNumber.run(profile.region, profile.tenantId, locationId, phone);
      database.prepare(`UPDATE called_numbers SET location_id = ?
        WHERE region_id = ? AND tenant_id = ? AND phone = ?`)
        .run(locationId, profile.region, profile.tenantId, phone);
    }
  });
}

const SQLITE_BUSY_RETRIES = 3;

function withWriteTransaction(database: DatabaseSync, operation: () => void): void {
  withSqliteBusyRetry(() => {
    database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* The transaction may not have started. */ }
      throw error;
    }
  });
}

function withSqliteBusyRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= SQLITE_BUSY_RETRIES) throw error;
      // DatabaseSync is synchronous; a short local wait gives the other startup
      // process time to finish its WAL/migration transaction without a hot loop.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|database is busy/i.test(message);
}
