import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DatabaseSnapshot {
  sourcePath: string;
  destinationPath: string;
  sha256: string;
  integrityCheck: string;
  foreignKeyViolations: number;
}

/**
 * Consistent SQLite snapshot via VACUUM INTO. Does not copy a live WAL file
 * by hand. The destination must not already exist.
 */
export function snapshotDatabase(sourcePath: string, destinationPath: string): DatabaseSnapshot {
  if (resolveSame(sourcePath, destinationPath)) {
    throw new Error("Refusing to snapshot a database onto itself");
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath);
  try {
    const escaped = destinationPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const foreignKeys = copy.prepare("PRAGMA foreign_key_check").all();
    const integrityCheck = integrity?.integrity_check ?? "missing";
    if (integrityCheck !== "ok") throw new Error(`Snapshot integrity_check failed: ${integrityCheck}`);
    if (foreignKeys.length > 0) throw new Error(`Snapshot foreign_key_check failed (${foreignKeys.length})`);
    return {
      sourcePath,
      destinationPath,
      sha256: createHash("sha256").update(readFileSync(destinationPath)).digest("hex"),
      integrityCheck,
      foreignKeyViolations: foreignKeys.length,
    };
  } finally {
    copy.close();
  }
}

function resolveSame(left: string, right: string): boolean {
  return left === right;
}
