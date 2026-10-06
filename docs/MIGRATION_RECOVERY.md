# Regional migration and recovery runbook

Prepared 2026-09-19. REL-001 has run on private copies of both local regional
databases; see [results and limits](REGIONAL_MIGRATION_REHEARSAL.md). These instructions
do not authorize changing a running deployment.

## Ownership and automatic writes

`src/infrastructure/database/regional-database.ts` registers migrations 1–11.
`migrateDatabase` uses a write transaction and `schema_migrations`; already-applied
versions are skipped. `openRegionalDatabase` enables foreign keys, a five-second
busy timeout and WAL. Configured API/Voice Lab startup migrates and seeds the chosen
regional DB; `pnpm db:init` migrates/seeds both. Seeding can update configured demo
DID mappings. Agent startup also upgrades saved configuration and compatible tools.
Treat starting new code against existing data as a write operation.

## Backup before migration

The [Checkpoint 6 backup CLI and templates](DEPLOYMENT_CHECKPOINT.md) implement
consistent online snapshots and restore into new directories. Their synthetic
rehearsal is complete; the target host and actual off-host restore remain open.

1. Record the exact Git commit, database paths, region/tenant selection and migration
   versions. Resolve paths from the actual process environment, not an assumed cwd.
2. Arrange a maintenance window and stop all API/Voice Lab writers for a cold backup,
   or use SQLite's consistent online backup facility. **Do not copy only the main
   `.sqlite` file while WAL writers are active.** Keep original WAL/SHM sidecars with
   an untouched stopped source; do not delete them to force startup.
3. Put backups in a private directory outside Git, with timestamps and checksums.
   Confirm they open read-only and run `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check`. Retain the originals unchanged.
4. Back up required secrets separately in protected storage, especially the Google
   token encryption key and admin signing key. Never put them into migration logs.
   Database backups contain patient/contact and encrypted credential data.

## Rehearse using disposable copies only

1. Make separate MX and US working copies from verified backups. Record pre-migration
   counts grouped by region/tenant for customers, appointments, calls, called numbers,
   business configuration and admin records; record available migration versions.
2. Export **both** `YIBO_DATABASE_MX` and `YIBO_DATABASE_US` to the disposable paths in
   the command environment. `db:init` does not load `.env`; a single missing override
   could target a default database. Verify both resolved paths before running it.
3. Run `pnpm db:init` against those copies, then run it again to check idempotency.
   Never point this rehearsal at original DBs. Inspect versions 1–11 and integrity/
   foreign-key checks after both runs.
4. Compare counts and invariants, explaining intentional seed additions. Check
   tenant isolation, default-location backfill, configuration versions, appointment
   name/price snapshots, original Google event IDs, times and statuses. Count equality
   alone does not prove preservation. Opening agent configuration may upgrade JSON;
   include that read path in the rehearsal. For migration 10, also verify customer
   metadata defaults, appointment outcomes, appointment events and notification
   deliveries. For migration 11, verify appointment revisions and preserve operation
   claims; reconcile them explicitly rather than clearing them during restore.
5. Run relevant SQLite tests, both typechecks, full tests and production build for
   REL-001. Keep a report containing counts/checksums/results, not raw customer rows.
   Verify calendar integration on isolated test resources only.

The existing automated migration tests use synthetic fixtures. They do not replace
this rehearsal on copies of the actual regional databases.

## Recovery / rollback

- Preserve the failed migrated copy and logs for diagnosis. Do not reset Git history,
  delete migrations or edit `schema_migrations` to pretend a migration was undone.
- Stop all writers before restoring. Restore a verified coherent backup to a **new**
  private path and point the appropriate regional override at it. Keep the original
  failed DB and its sidecars intact; avoid mixing old WAL files with restored data.
- Use the matching pre-change application commit only after checking schema/config
  compatibility. An older binary is not automatically compatible with upgraded JSON.
- Re-run integrity/foreign-key checks, counts and scoped read checks before admitting
  traffic. Confirm access to the matching encryption/signing secrets; OAuth may need
  reconnecting if its key cannot be recovered.
- SQLite restore does **not** roll back Google events created/changed since backup.
  Reconcile appointments against their original external event IDs and calendar
  mappings before reopening booking. Do not bulk recreate or delete events.
- Lost post-backup writes require explicit reconciliation. Record the recovery point
  and operational impact; never claim zero data loss from a backup alone.

Release closure remains REL-002. Live PBX/provider acceptance and known deployment
limits are tracked in [project status](PROJECT_STATUS.md) and the E2E runbooks.
