import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { snapshotDatabase } from "../../src/infrastructure/database/snapshot-database.js";

const dir = mkdtempSync(join(tmpdir(), "yibo-snap-"));
try {
  const source = join(dir, "source.sqlite");
  const destination = join(dir, "copy.sqlite");
  const database = openRegionalDatabase("US", source);
  migrateDatabase(database);
  database.close();
  const snapshot = snapshotDatabase(source, destination);
  if (snapshot.integrityCheck !== "ok" || snapshot.foreignKeyViolations !== 0) {
    throw new Error("snapshot checks failed");
  }
  if (!/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw new Error("missing checksum");
  const copy = openRegionalDatabase("US", destination);
  const row = copy.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
  copy.close();
  if (row.n < 1) throw new Error("snapshot missed migrations");
  process.stdout.write("snapshot integrity:ok\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
