import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApiServer } from "../../src/api/index.js";
import { buildApplication } from "../../src/bootstrap/build-application.js";
import { DEVELOPMENT_BUSINESS, DEVELOPMENT_US_BUSINESS } from "../../src/app/development-fixtures.js";
import { migrateDatabase, openRegionalDatabase, seedBusiness } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAdminIdentityRepository } from "../../src/infrastructure/database/sqlite-admin-identity-repository.js";
import { SqliteAgentConfigurationRepository } from "../../src/infrastructure/database/sqlite-agent-configuration-repository.js";
import { SqliteAppointmentRepository } from "../../src/infrastructure/database/sqlite-appointment-repository.js";
import { SqliteBusinessRepository } from "../../src/infrastructure/database/sqlite-business-repository.js";
import { SqliteCustomerRepository } from "../../src/infrastructure/database/sqlite-customer-repository.js";
import { SqliteGoogleTokenStore } from "../../src/infrastructure/database/sqlite-google-token-store.js";
import { SqliteNotificationRepository } from "../../src/infrastructure/database/sqlite-notification-repository.js";
import { AgentConfigurationService, DEFAULT_REALTIME_MODEL } from "../../src/modules/agents/index.js";
import { AdminCredentialService, ScryptPasswordHasher } from "../../src/modules/auth/index.js";
import { upgradeBusinessProfile } from "../../src/modules/business/index.js";
import { configuredBackupSources, createRegionalBackup, restoreRegionalBackup, verifyRegionalBackup } from "../../src/operations/regional-backup.js";
import type { RegionId } from "../../src/shared/types/identifiers.js";

process.umask(0o077);
globalThis.fetch = async () => { throw new Error("Live providers forbidden in restore rehearsal"); };
const directory = mkdtempSync(join(tmpdir(), "yibo-backup-test-"));
const snapshot = join(directory, "snapshot");
const restored = join(directory, "restored");
const release = "a".repeat(40);
const handles: DatabaseSync[] = [];
const scenario = process.argv[2];

function source(region: RegionId) {
  const path = join(directory, `${region}-source.sqlite`);
  const db = openRegionalDatabase(region, path);
  handles.push(db);
  db.exec("PRAGMA wal_autocheckpoint = 0");
  migrateDatabase(db);
  const profile = upgradeBusinessProfile(structuredClone(region === "MX" ? DEVELOPMENT_BUSINESS : DEVELOPMENT_US_BUSINESS));
  profile.displayCurrency = "EUR";
  profile.locations[0]!.defaultCalendarId = `${region}-synthetic-calendar@example.test`;
  profile.locations[0]!.agentOverrides = { allowPriceDisclosure: false, phoneReadback: "digit_by_digit", locale: "en-GB" };
  seedBusiness(db, profile);
  return { path, region, db, profile };
}
const capture = (s: { path: string }) => [readFileSync(s.path), readFileSync(s.path + "-wal")];
const create = (sources: { path: string; region: RegionId }[]) => createRegionalBackup({ sources, directory: snapshot, release });
const manifest = () => JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"));
const changeManifest = (change: (value: ReturnType<typeof manifest>) => void) => {
  const value = manifest(); change(value); writeFileSync(join(snapshot, "manifest.json"), JSON.stringify(value));
};

try {
  if (scenario === "restores-business-data-and-login") {
    const sources = [source("MX"), source("US")];
    const password = randomBytes(24).toString("hex");
    const encryptionKey = randomBytes(32).toString("hex");
    const fakeToken = { accessToken: "synthetic-access-only", refreshToken: "synthetic-refresh-only", expiresAt: "2030-01-01T00:00:00Z" };
    for (const { db, region, profile } of sources) {
      await new AdminCredentialService(new SqliteAdminIdentityRepository(db, region), new ScryptPasswordHasher(), () => "owner-test")
        .create({ tenantId: profile.tenantId, email: "owner@example.test", password, roles: ["owner"] });
      const agents = new AgentConfigurationService(new SqliteAgentConfigurationRepository(db, region));
      const config = agents.recommended("en-GB", "Restore Test", DEFAULT_REALTIME_MODEL);
      await agents.update(profile.tenantId, config);
      await new SqliteGoogleTokenStore(db, region, encryptionKey).save(profile.tenantId, fakeToken);
      db.prepare(`INSERT INTO customers(region_id, tenant_id, id, phone, name, email, preferred_language, email_opt_in)
        VALUES (?, ?, 'same-customer', '+15550000444', 'Synthetic Restore', 'restore@example.test', 'en-GB', 0)`)
        .run(region, profile.tenantId);
      db.prepare(`INSERT INTO appointments(region_id, tenant_id, location_id, id, customer_id, service_id, employee_id,
        start_at, end_at, status, idempotency_key, source, external_calendar_event_id, service_name_snapshot,
        price_amount_minor, price_currency, version, outcome_status)
        VALUES (?, ?, 'default', 'same-appointment', 'same-customer', 'consultation', ?,
        '2026-10-05T15:00:00.000Z', '2026-10-05T15:30:00.000Z', 'CONFIRMED', 'same-key', 'DASHBOARD',
        'original-event-identity', 'Historical consultation', 12550, 'EUR', 4, 'COMPLETED')`)
        .run(region, profile.tenantId, profile.professionals[0]!.id);
      await new SqliteAppointmentRepository(db, region).appendEvent({ id: "history-1", tenantId: profile.tenantId,
        appointmentId: "same-appointment", type: "COMPLETED", actorType: "OFFICE", occurredAt: "2026-10-05T16:00:00Z" });
      await new SqliteNotificationRepository(db, region).save({ id: "notification-1", tenantId: profile.tenantId,
        appointmentId: "same-appointment", kind: "CONFIRMATION", channel: "EMAIL", destinationMasked: "r***@example.test",
        status: "SKIPPED", createdAt: "2026-10-05T16:00:00Z", updatedAt: "2026-10-05T16:00:00Z" });
      db.prepare(`INSERT INTO appointment_operation_locks
        (region_id, tenant_id, location_id, owner_id, owner_pid, acquired_at)
        VALUES (?, ?, 'default', 'crashed-writer-test', 1, '2026-10-05T16:00:00Z')`)
        .run(region, profile.tenantId);
    }
    const before = sources.map(capture);
    const result = await create(sources);
    assert.deepEqual(result.databases.map(row => row.region), ["MX", "US"]);
    assert.deepEqual(await verifyRegionalBackup(snapshot), result);
    assert.deepEqual(await restoreRegionalBackup(snapshot, restored), result);
    assert.equal(lstatSync(restored).mode & 0o777, 0o700);
    for (const [i, original] of sources.entries()) {
      assert.deepEqual(capture(original), before[i], "backup must leave source main/WAL bytes untouched");
      const path = join(restored, `${original.region.toLowerCase()}.sqlite`);
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      assert(!readFileSync(path).includes(fakeToken.refreshToken), "token remains encrypted in the restored database");
      const db = new DatabaseSync(path, { readOnly: true }); handles.push(db);
      const { region, profile } = original;
      const business = await new SqliteBusinessRepository(db, region).findConfigurationByTenantId(profile.tenantId);
      assert.deepEqual(business!.profile, profile, "services, staff, assignments, hours, routing and AI rules survive");
      assert.deepEqual(await new SqliteAgentConfigurationRepository(db, region).getConfiguration(profile.tenantId),
        await new SqliteAgentConfigurationRepository(original.db, region).getConfiguration(profile.tenantId));
      const customer = await new SqliteCustomerRepository(db, region).findById(profile.tenantId, "same-customer");
      assert.equal(customer!.emailOptIn, false); assert.equal(customer!.preferredLanguage, "en-GB");
      const appointments = new SqliteAppointmentRepository(db, region);
      const appointment = await appointments.findById(profile.tenantId, "same-appointment");
      assert.equal(appointment!.version, 4); assert.equal(appointment!.externalCalendarEventId, "original-event-identity");
      assert.equal(appointment!.priceAmountMinor, 12550); assert.equal(appointment!.outcomeStatus, "COMPLETED");
      assert.equal(appointment!.startAt, "2026-10-05T15:00:00.000Z");
      assert.equal((await appointments.listEvents(profile.tenantId, "same-appointment")).length, 1);
      assert.equal(await appointments.findById("another-tenant", "same-appointment"), null);
      assert.equal((await new SqliteNotificationRepository(db, region).list(profile.tenantId, "same-appointment"))[0]!.status, "SKIPPED");
      assert.equal((db.prepare("SELECT count(*) AS n FROM appointment_operation_locks").get() as { n: number }).n, 1,
        "restore must not automatically clear abandoned claims");
      assert.deepEqual(await new SqliteGoogleTokenStore(db, region, encryptionKey).get(profile.tenantId), fakeToken);
      await assert.rejects(new SqliteGoogleTokenStore(db, region, randomBytes(32).toString("hex")).get(profile.tenantId));
      const app = buildApplication({ tenantId: profile.tenantId, businesses: [profile],
        environment: { YIBO_DASHBOARD_ORIGIN: "https://restore.example.test" },
        adminSessionSecret: randomBytes(32).toString("hex"), adminIdentityRepository: new SqliteAdminIdentityRepository(db, region),
        businessRepository: new SqliteBusinessRepository(db, region) });
      const server = await createApiServer(app);
      try {
        assert.equal((await server.inject({ method: "GET", url: "/api/auth/me" })).statusCode, 401);
        const login = await server.inject({ method: "POST", url: "/api/auth/login",
          headers: { origin: "https://restore.example.test" }, payload: { email: "owner@example.test", password } });
        assert.equal(login.statusCode, 200, "restored owner can actually sign in through Fastify");
        assert.deepEqual(login.json().principal.roles, ["owner"]);
        const cookie = login.headers["set-cookie"];
        assert.equal((await server.inject({ method: "GET", url: "/api/business", headers: { cookie } })).statusCode, 200);
        assert.equal((await server.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://wrong.example.test" },
          payload: { email: "owner@example.test", password } })).statusCode, 403);
      } finally { await server.close(); }
    }
    assert.deepEqual(await verifyRegionalBackup(snapshot), result, "rehearsal did not mutate the backup");
  } else if (scenario === "committed-wal-only") {
    const s = source("US");
    s.db.exec("CREATE TABLE wal_probe(value TEXT); INSERT INTO wal_probe VALUES ('committed'); BEGIN IMMEDIATE; INSERT INTO wal_probe VALUES ('uncommitted')");
    await create([s]);
    const db = new DatabaseSync(join(snapshot, "us.sqlite"), { readOnly: true }); handles.push(db);
    assert.deepEqual(db.prepare("SELECT value FROM wal_probe").all().map(row => row.value), ["committed"]);
    s.db.exec("ROLLBACK; INSERT INTO wal_probe VALUES ('after-backup')");
    assert.equal(db.prepare("SELECT count(*) AS n FROM wal_probe").get()!.n, 1);
  } else if (scenario === "explicit-paths-and-regions") {
    assert.throws(() => configuredBackupSources("US", {}), /EXPLICIT_DATABASE_PATH_REQUIRED/);
    assert.throws(() => configuredBackupSources("US", { YIBO_DATABASE_US: "data/us.sqlite" }), /EXPLICIT_DATABASE_PATH_REQUIRED/);
    assert.throws(() => configuredBackupSources("US,US", {}), /INVALID_REGIONS/);
    assert.throws(() => configuredBackupSources("EU", {}), /INVALID_REGIONS/);
    assert.throws(() => configuredBackupSources("US", { YIBO_DATABASE_US: "/us.sqlite", YIBO_DATABASE_MX: "/mx.sqlite" }), /CONFIGURED_REGION_OMITTED/);
    assert.deepEqual(configuredBackupSources("US", { YIBO_DATABASE_US: "/us.sqlite" }), [{ region: "US", path: "/us.sqlite" }]);
  } else if (scenario === "missing-source") {
    await assert.rejects(create([{ region: "US", path: join(directory, "missing.sqlite") }]));
    assert(!existsSync(snapshot)); assert(!existsSync(join(directory, "missing.sqlite")));
  } else if (scenario === "wrong-region") {
    const s = source("US");
    await assert.rejects(create([{ region: "MX", path: s.path }]), /DATABASE_REGION_MISMATCH/);
    assert(!existsSync(join(snapshot, "manifest.json")));
  } else if (scenario === "duplicate-source") {
    const s = source("US");
    await assert.rejects(create([s, { region: "MX", path: s.path }]), /DUPLICATE_DATABASE_PATH/);
    assert(!existsSync(snapshot));
  } else if (scenario === "existing-snapshot") {
    const s = source("US"); mkdirSync(snapshot); writeFileSync(join(snapshot, "keep"), "original");
    await assert.rejects(create([s])); assert.equal(readFileSync(join(snapshot, "keep"), "utf8"), "original");
  } else if (scenario === "existing-restore") {
    await create([source("US")]); mkdirSync(restored); writeFileSync(join(restored, "us.sqlite-wal"), "keep-original");
    await assert.rejects(restoreRegionalBackup(snapshot, restored));
    assert.equal(readFileSync(join(restored, "us.sqlite-wal"), "utf8"), "keep-original");
  } else if (scenario === "corrupted-snapshot") {
    await create([source("US")]); appendFileSync(join(snapshot, "us.sqlite"), "tampered");
    await assert.rejects(restoreRegionalBackup(snapshot, restored), /BACKUP_CHECKSUM_MISMATCH/); assert(!existsSync(restored));
  } else if (scenario === "unsafe-manifest") {
    await create([source("US")]); changeManifest(value => { value.databases[0].file = "../US-source.sqlite"; });
    await assert.rejects(verifyRegionalBackup(snapshot), /INVALID_MANIFEST/);
    changeManifest(value => { value.databases[0].file = "us.sqlite"; value.databases.push(value.databases[0]); });
    await assert.rejects(verifyRegionalBackup(snapshot), /INVALID_MANIFEST/);
  } else if (scenario === "symlink-snapshot") {
    const s = source("US"); await create([s]); rmSync(join(snapshot, "us.sqlite"));
    symlinkSync(s.path, join(snapshot, "us.sqlite"));
    await assert.rejects(verifyRegionalBackup(snapshot), /REGULAR_FILE_REQUIRED/);
  } else if (scenario === "snapshot-sidecars") {
    await create([source("US")]); writeFileSync(join(snapshot, "us.sqlite-wal"), "unrelated WAL");
    await assert.rejects(restoreRegionalBackup(snapshot, restored), /SNAPSHOT_SIDECAR_PRESENT/); assert(!existsSync(restored));
  } else if (scenario === "partial-backup") {
    const us = source("US"); const bad = join(directory, "bad.sqlite"); writeFileSync(bad, "not sqlite");
    await assert.rejects(create([us, { region: "MX", path: bad }]));
    assert(!existsSync(join(snapshot, "manifest.json")));
    await assert.rejects(restoreRegionalBackup(snapshot, restored)); assert(!existsSync(restored));
  } else if (scenario === "metadata-tampering") {
    await create([source("US")]); changeManifest(value => { value.databases[0].tableCounts.customers = 999; });
    await assert.rejects(verifyRegionalBackup(snapshot), /BACKUP_METADATA_MISMATCH/);
  } else if (scenario === "cli-roundtrip-and-safe-errors") {
    const s = source("US");
    const env = { ...process.env, YIBO_DATABASE_US: s.path, YIBO_DATABASE_MX: "" };
    const call = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", "src/cli/database-backup.ts", ...args], { encoding: "utf8", env }).trim());
    assert.equal(call("create", "--directory", snapshot, "--regions", "US", "--release", release).event, "backup.create.complete");
    assert.equal(call("verify", "--directory", snapshot).event, "backup.verify.complete");
    assert.equal(call("restore", "--snapshot", snapshot, "--directory", restored).event, "backup.restore.complete");
    const failure = spawnSync(process.execPath, ["--import", "tsx", "src/cli/database-backup.ts", "verify", "--directory",
      join(directory, "private-do-not-disclose")], { encoding: "utf8", env });
    assert.equal(failure.status, 1); assert(!failure.stderr.includes("private-do-not-disclose"));
    assert(failure.stderr.includes('"code":"BACKUP_OPERATION_FAILED"'));
  } else if (scenario?.startsWith("job-")) {
    const s = source("US");
    const staging = join(directory, "staging"); const bin = join(directory, "bin");
    mkdirSync(staging, { mode: 0o700 }); mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const invocation = join(directory, "restic-invocation");
    // This stub exercises scheduling/upload failure handling, not real off-host storage.
    writeFileSync(join(bin, "restic"), '#!/bin/sh\ntest -z "${RESTIC_REPOSITORY+x}" || exit 91\ntest -z "${RESTIC_PASSWORD+x}" || exit 92\ntest -z "${RESTIC_PASSWORD_COMMAND+x}" || exit 93\nprintf "%s\\n" "$*" > "$YIBO_TEST_RESTIC_ARGS"\nprintf "%s\\n" "private-provider-diagnostic"\nexit "$YIBO_TEST_RESTIC_EXIT"\n', { mode: 0o700 });
    const repository = join(directory, "repository"); const passwordFile = join(directory, "password");
    writeFileSync(repository, scenario === "job-rejects-local-repository" ? "/local/repository" : "s3:https://storage.example.test/bucket");
    writeFileSync(passwordFile, randomBytes(32).toString("hex"));
    const result = spawnSync("/bin/sh", ["deploy/backup/run-backup.sh"], { encoding: "utf8", timeout: 30_000, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, YIBO_DATABASE_US: s.path,
      YIBO_DATABASE_MX: scenario === "job-rejects-omitted-region" ? join(directory, "MX-source.sqlite") : "",
      YIBO_BACKUP_ROOT: staging, YIBO_BACKUP_REGIONS: "US", YIBO_RELEASE_SHA: release,
      RESTIC_REPOSITORY_FILE: repository, RESTIC_PASSWORD_FILE: passwordFile,
      RESTIC_REPOSITORY: "/wrong-local-repository", RESTIC_PASSWORD: "unused-test-default", RESTIC_PASSWORD_COMMAND: "unused-test-command",
      YIBO_TEST_RESTIC_ARGS: invocation, YIBO_TEST_RESTIC_EXIT: scenario === "job-incomplete-upload" ? "3" : "0",
    } });
    assert(!result.stdout.includes("private-provider-diagnostic") && !result.stderr.includes("private-provider-diagnostic"));
    if (scenario === "job-rejects-local-repository" || scenario === "job-rejects-omitted-region") {
      assert.equal(result.status, 1); assert(!existsSync(invocation)); assert.equal(readdirSync(staging).length, 0);
    } else {
      assert.equal(result.status, scenario === "job-incomplete-upload" ? 1 : 0);
      const snapshots = readdirSync(staging).filter(name => lstatSync(join(staging, name)).isDirectory());
      assert.equal(snapshots.length, 1, "successful and failed uploads both preserve the local snapshot");
      await verifyRegionalBackup(join(staging, snapshots[0]!));
      assert(readFileSync(invocation, "utf8").startsWith(`--repository-file ${repository} --password-file ${passwordFile} backup --tag yibo-regional -- `));
      const log = join(staging, `${snapshots[0]}-upload.log`);
      assert.equal(lstatSync(log).mode & 0o777, 0o600);
      assert(readFileSync(log, "utf8").includes("private-provider-diagnostic"));
      assert((result.stdout + result.stderr).includes(scenario === "job-incomplete-upload" ? "OFF_HOST_UPLOAD_FAILED" : "backup.upload.complete"));
    }
  } else { throw new Error("Unknown backup test scenario"); }
  console.log(JSON.stringify({ scenario, passed: true }));
} finally {
  for (const db of handles.reverse()) db.close();
  rmSync(directory, { recursive: true, force: true });
}
