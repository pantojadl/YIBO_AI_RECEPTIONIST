import { parseArgs } from "node:util";
import { BackupError, configuredBackupSources, createRegionalBackup, restoreRegionalBackup, verifyRegionalBackup } from "../operations/regional-backup.js";

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    directory: { type: "string" }, snapshot: { type: "string" }, regions: { type: "string" }, release: { type: "string" },
  } });
  const [command] = positionals;
  if (positionals.length !== 1 || !values.directory) throw new BackupError("INVALID_BACKUP_ARGUMENTS");
  let manifest;
  if (command === "create" && values.regions && values.release && !values.snapshot) {
    manifest = await createRegionalBackup({ sources: configuredBackupSources(values.regions, process.env),
      directory: values.directory, release: values.release });
  } else if (command === "verify" && !values.snapshot && !values.regions && !values.release) {
    manifest = await verifyRegionalBackup(values.directory);
  } else if (command === "restore" && values.snapshot && !values.regions && !values.release) {
    manifest = await restoreRegionalBackup(values.snapshot, values.directory);
  } else { throw new BackupError("INVALID_BACKUP_ARGUMENTS"); }
  console.log(JSON.stringify({ event: `backup.${command}.complete`, regions: manifest.databases.map(entry => entry.region), release: manifest.release }));
} catch (error) {
  // SQLite, filesystem and provider messages can contain paths or data. Emit only safe codes.
  console.error(JSON.stringify({ event: "backup.failed", code: error instanceof BackupError ? error.message : "BACKUP_OPERATION_FAILED" }));
  process.exitCode = 1;
}
