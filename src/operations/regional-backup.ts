import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, createReadStream, existsSync,
  fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RegionId } from "../shared/types/identifiers.js";

export class BackupError extends Error {}

interface DatabaseSummary {
  migrations: number[];
  tableCounts: Record<string, number>;
}
interface BackupFile extends DatabaseSummary {
  region: RegionId;
  file: string;
  bytes: number;
  sha256: string;
}
export interface BackupManifest {
  format: 1;
  createdAt: string;
  release: string;
  databases: BackupFile[];
}
export interface BackupSource { region: RegionId; path: string }

const requireThat: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw new BackupError(code);
};
const fileName = (region: RegionId) => `${region.toLowerCase()}.sqlite`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function configuredBackupSources(regions: string, environment: NodeJS.ProcessEnv): BackupSource[] {
  const selected = regions.split(",");
  requireThat(selected.length > 0 && selected.every(value => value === "MX" || value === "US")
    && new Set(selected).size === selected.length, "INVALID_REGIONS");
  for (const region of ["MX", "US"] as const) {
    requireThat(!environment[`YIBO_DATABASE_${region}`]?.trim() || selected.includes(region), "CONFIGURED_REGION_OMITTED");
  }
  return (selected as RegionId[]).map(region => {
    const path = environment[`YIBO_DATABASE_${region}`]?.trim();
    requireThat(path && isAbsolute(path), "EXPLICIT_DATABASE_PATH_REQUIRED");
    return { region, path };
  });
}

function regularFile(path: string): void {
  requireThat(lstatSync(path).isFile(), "REGULAR_FILE_REQUIRED");
}

function inspectDatabase(path: string, region: RegionId): DatabaseSummary {
  regularFile(path);
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    requireThat(integrity.length === 1 && Object.values(integrity[0]!)[0] === "ok", "DATABASE_INTEGRITY_FAILED");
    requireThat(db.prepare("PRAGMA foreign_key_check").all().length === 0, "DATABASE_FOREIGN_KEYS_FAILED");
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    requireThat(tables.some(({ name }) => name === "schema_migrations")
      && tables.some(({ name }) => name === "businesses"), "NOT_A_YIBO_DATABASE");
    const tableCounts: Record<string, number> = {};
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[];
      if (columns.some(column => column.name === "region_id")) {
        requireThat(!db.prepare(`SELECT 1 FROM ${quote(name)} WHERE region_id IS NULL OR region_id <> ? LIMIT 1`).get(region),
          "DATABASE_REGION_MISMATCH");
      }
      tableCounts[name] = (db.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get() as { count: number }).count;
    }
    const migrations = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[])
      .map(row => row.version);
    requireThat(migrations.length > 0 && migrations.every(Number.isSafeInteger), "INVALID_MIGRATION_HISTORY");
    return { migrations, tableCounts };
  } finally { db.close(); }
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function newPrivateDirectory(directory: string): void {
  requireThat(isAbsolute(directory), "ABSOLUTE_DIRECTORY_REQUIRED");
  // No recursive mkdir or replacement: an existing destination, even empty, is refused.
  mkdirSync(directory, { mode: 0o700 });
}

export async function createRegionalBackup(options: {
  sources: BackupSource[]; directory: string; release: string;
}): Promise<BackupManifest> {
  requireThat(/^[a-f0-9]{40}$/i.test(options.release), "RELEASE_SHA_REQUIRED");
  const { sources, directory } = options;
  requireThat(sources.length >= 1 && sources.length <= 2
    && sources.every(source => source.region === "MX" || source.region === "US")
    && new Set(sources.map(source => source.region)).size === sources.length, "INVALID_REGIONS");
  for (const source of sources) {
    requireThat(isAbsolute(source.path), "EXPLICIT_DATABASE_PATH_REQUIRED");
    regularFile(source.path);
  }
  requireThat(new Set(sources.map(source => realpathSync(source.path))).size === sources.length, "DUPLICATE_DATABASE_PATH");
  newPrivateDirectory(directory);
  const manifest: BackupManifest = { format: 1, createdAt: new Date().toISOString(), release: options.release, databases: [] };
  for (const source of sources) {
    const file = fileName(source.region);
    const target = join(directory, file);
    // backup() can overwrite its destination; reserve only a new file in our private directory.
    closeSync(openSync(target, "wx", 0o600));
    await copyConsistentSnapshot(source.path, target);
    // Make the owned snapshot standalone. Never change the source's journal mode.
    const snapshot = new DatabaseSync(target);
    try { snapshot.exec("PRAGMA journal_mode = DELETE"); } finally { snapshot.close(); }
    chmodSync(target, 0o600);
    const summary = inspectDatabase(target, source.region);
    sync(target);
    manifest.databases.push({ region: source.region, file, ...summary,
      bytes: lstatSync(target).size, sha256: await checksum(target) });
  }
  // A failed or interrupted run has no completion manifest and cannot be restored.
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  sync(join(directory, "manifest.json"));
  sync(directory);
  return manifest;
}

function readManifest(directory: string): BackupManifest {
  requireThat(isAbsolute(directory) && lstatSync(directory).isDirectory(), "ABSOLUTE_DIRECTORY_REQUIRED");
  const path = join(directory, "manifest.json");
  regularFile(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  requireThat(value?.format === 1 && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.release === "string" && /^[a-f0-9]{40}$/i.test(value.release)
    && Array.isArray(value.databases) && value.databases.length >= 1 && value.databases.length <= 2, "INVALID_MANIFEST");
  const regions = new Set<RegionId>();
  for (const entry of value.databases) {
    requireThat(entry && (entry.region === "MX" || entry.region === "US") && !regions.has(entry.region)
      && entry.file === fileName(entry.region) && /^[a-f0-9]{64}$/.test(entry.sha256)
      && Number.isSafeInteger(entry.bytes) && entry.bytes > 0
      && Array.isArray(entry.migrations) && entry.tableCounts && typeof entry.tableCounts === "object", "INVALID_MANIFEST");
    regions.add(entry.region);
  }
  return value;
}

export async function verifyRegionalBackup(directory: string): Promise<BackupManifest> {
  const manifest = readManifest(directory);
  for (const entry of manifest.databases) {
    const path = join(directory, entry.file);
    regularFile(path);
    requireThat(!existsSync(path + "-wal") && !existsSync(path + "-shm") && !existsSync(path + "-journal"), "SNAPSHOT_SIDECAR_PRESENT");
    requireThat(lstatSync(path).size === entry.bytes && await checksum(path) === entry.sha256, "BACKUP_CHECKSUM_MISMATCH");
    const actual = inspectDatabase(path, entry.region);
    requireThat(JSON.stringify(actual.migrations) === JSON.stringify(entry.migrations)
      && JSON.stringify(actual.tableCounts) === JSON.stringify(entry.tableCounts), "BACKUP_METADATA_MISMATCH");
  }
  return manifest;
}

/** Online snapshot that does not change the source journal mode. */
async function copyConsistentSnapshot(sourcePath: string, target: string): Promise<void> {
  const sqlite = await import("node:sqlite") as unknown as {
    backup?: (sourceDb: DatabaseSync, path: string) => Promise<unknown>;
  };
  const db = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
  try {
    if (typeof sqlite.backup === "function") {
      await sqlite.backup(db, target);
      return;
    }
    // node:sqlite's backup() is not exported on the Node 22.13/22.14 runtime this
    // project supports. VACUUM INTO writes a new consistent file and refuses to
    // replace an existing one, so drop only the placeholder we just reserved.
    unlinkSync(target);
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

export async function restoreRegionalBackup(snapshot: string, destination: string): Promise<BackupManifest> {
  const manifest = await verifyRegionalBackup(snapshot);
  newPrivateDirectory(destination);
  for (const entry of manifest.databases) {
    const target = join(destination, entry.file);
    copyFileSync(join(snapshot, entry.file), target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    sync(target);
  }
  // Restore creates new files only. It never switches application paths, starts writers,
  // contacts providers, runs migrations, or clears appointment operation claims.
  copyFileSync(join(snapshot, "manifest.json"), join(destination, "manifest.json"), constants.COPYFILE_EXCL);
  chmodSync(join(destination, "manifest.json"), 0o600);
  sync(join(destination, "manifest.json"));
  sync(destination);
  return verifyRegionalBackup(destination);
}
