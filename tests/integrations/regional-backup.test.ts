import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("regional backup and restore on disposable SQLite databases", () => {
  it.each([
    "restores-business-data-and-login", "committed-wal-only", "explicit-paths-and-regions", "missing-source",
    "wrong-region", "duplicate-source", "existing-snapshot", "existing-restore", "corrupted-snapshot",
    "unsafe-manifest", "symlink-snapshot", "snapshot-sidecars", "partial-backup", "metadata-tampering",
    "cli-roundtrip-and-safe-errors",
    "job-success", "job-incomplete-upload", "job-rejects-local-repository", "job-rejects-omitted-region",
  ])("%s", scenario => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/regional-backup.ts", scenario], {
      encoding: "utf8", cwd: process.cwd(), timeout: 30_000,
    });
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ scenario, passed: true });
  }, 35_000);
});
