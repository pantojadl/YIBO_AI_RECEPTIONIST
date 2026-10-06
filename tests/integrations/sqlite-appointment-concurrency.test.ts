import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it("coordinates configured API/voice writers and a real child process using persisted scoped locks and versions", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-appointment-concurrency.ts"],
    { encoding: "utf8", timeout: 10_000, cwd: process.cwd() });
  expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ sameDatabaseWriters: true, realProcessContention: true, crashFailsClosed: true,
    scopedLocks: true, providerFailureReleases: true, revisionsPersisted: true, originalEventPreserved: true, noDuplicates: true, neighborUnchanged: true });
});
