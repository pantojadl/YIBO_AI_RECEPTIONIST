import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { migrateDatabase, seedBusiness } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";
import { SqliteCustomerRepository } from "../../src/infrastructure/database/sqlite-customer-repository.js";
import { SqliteNotificationRepository } from "../../src/infrastructure/database/sqlite-notification-repository.js";

const directory = mkdtempSync(join(tmpdir(), "yibo-launch-migration-"));
try {
  for (const base of [DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS]) {
    const sourcePath = join(directory, `${base.region}-source.sqlite`);
    const migratedPath = join(directory, `${base.region}-copy.sqlite`);
    const source = new DatabaseSync(sourcePath);
    source.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const migrations = new URL("../../src/infrastructure/database/migrations/", import.meta.url);
    for (const file of readdirSync(migrations).filter(file => /^00[1-9]_.*\.sql$/.test(file)).sort()) {
      source.exec(readFileSync(new URL(file, migrations), "utf8"));
      source.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(Number(file.slice(0, 3)), "2026-09-24");
    }
    const profile = structuredClone(base);
    profile.displayCurrency = "EUR";
    profile.locations[0]!.agentOverrides = { allowPriceDisclosure: false, phoneReadback: "digit_by_digit", locale: "en-GB" };
    profile.locations[0]!.policies.availabilitySuggestions = { enabled: true, expansionDays: 2, maximumAlternatives: 3 };
    seedBusiness(source, profile);
    source.prepare("INSERT INTO customers(region_id, tenant_id, id, phone, name, email) VALUES (?, ?, ?, ?, ?, ?)")
      .run(base.region, base.tenantId, "same-id", "+15550000444", "Migration Example", "migration@example.test");
    source.prepare(`INSERT INTO appointments(region_id, tenant_id, location_id, id, customer_id, service_id, employee_id,
      start_at, end_at, status, idempotency_key, source, external_calendar_event_id, service_name_snapshot, price_amount_minor, price_currency)
      VALUES (?, ?, 'default', 'same-id', 'same-id', 'consultation', ?, '2026-10-01T15:00:00.000Z', '2026-10-01T15:30:00.000Z',
      'CONFIRMED', 'migration-key', 'DASHBOARD', 'original-google-event', 'Historical consultation', 12550, 'USD')`)
      .run(base.region, base.tenantId, base.professionals[0]!.id);
    source.close(); const before = readFileSync(sourcePath);
    cpSync(sourcePath, migratedPath);
    const database = new DatabaseSync(migratedPath); database.exec("PRAGMA foreign_keys = ON");
    try {
      migrateDatabase(database); migrateDatabase(database);
      const appointments = new SqliteAppointmentRepository(database, base.region);
      const customers = new SqliteCustomerRepository(database, base.region);
      const notifications = new SqliteNotificationRepository(database, base.region);
      const appointment = await appointments.findById(base.tenantId, "same-id"); assert(appointment);
      assert.equal(appointment.version, 1);
      assert.equal(appointment.externalCalendarEventId, "original-google-event"); assert.equal(appointment.priceAmountMinor, 12550);
      assert.equal(appointment.priceCurrency, "USD"); assert.equal(appointment.serviceNameSnapshot, "Historical consultation");
      const customer = await customers.findById(base.tenantId, "same-id"); assert(customer);
      assert.equal(customer.phone, "+15550000444"); assert.equal(customer.email, "migration@example.test"); assert.equal(customer.emailOptIn, true);
      await customers.save({ ...customer, preferredLanguage: "en-GB", emailOptIn: false });
      await appointments.save({ ...appointment, outcomeStatus: "COMPLETED" });
      await appointments.appendEvent({ id: "event-1", appointmentId: appointment.id, tenantId: base.tenantId, type: "COMPLETED", occurredAt: "2026-10-01T16:00:00Z", actorType: "OFFICE" });
      await notifications.save({ id: "notice-1", tenantId: base.tenantId, appointmentId: appointment.id, kind: "CONFIRMATION", channel: "EMAIL",
        destinationMasked: "m***@example.test", status: "SKIPPED", createdAt: "2026-10-01T16:00:00Z", updatedAt: "2026-10-01T16:00:00Z" });
      const range = { tenantId: base.tenantId, locationId: "default", rangeStart: "2026-10-01T00:00:00.000Z", rangeEnd: "2026-10-02T00:00:00.000Z" };
      assert.equal((await appointments.findInRange(range))[0]!.outcomeStatus, "COMPLETED");
      assert.equal((await appointments.findByRange({ ...range, status: "COMPLETED" })).length, 1);
      assert.equal((await appointments.findByRange({ ...range, status: "NO_SHOW" })).length, 0);
      assert.equal((await appointments.listEvents(base.tenantId, appointment.id)).length, 1);
      assert.equal((await notifications.list(base.tenantId, appointment.id)).length, 1);
      assert.equal((await notifications.list("foreign", appointment.id)).length, 0);
      assert.deepEqual(JSON.parse((database.prepare("SELECT profile_json FROM businesses WHERE region_id = ? AND tenant_id = ?").get(base.region, base.tenantId) as { profile_json: string }).profile_json), profile);
      assert.equal((database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=11").get() as { n: number }).n, 1);
      assert.equal((database.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=10").get() as { n: number }).n, 1);
    } finally { database.close(); }
    assert.deepEqual(readFileSync(sourcePath), before);
    const reopened = new DatabaseSync(migratedPath);
    try {
      assert.equal((await new SqliteAppointmentRepository(reopened, base.region).findById(base.tenantId, "same-id"))!.outcomeStatus, "COMPLETED");
      assert.equal((await new SqliteCustomerRepository(reopened, base.region).findById(base.tenantId, "same-id"))!.emailOptIn, false);
    } finally { reopened.close(); }
  }
  console.log(JSON.stringify({ copies: ["MX", "US"], sourceUnchanged: true, migration10Idempotent: true, migration11Idempotent: true, configurationPreserved: true, bothCalendarReads: true, customerHistoryAndNotifications: true }));
} finally { rmSync(directory, { recursive: true, force: true }); }
