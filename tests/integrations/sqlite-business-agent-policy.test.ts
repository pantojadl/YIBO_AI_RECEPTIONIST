import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("persists business/location agent rules across a database reopen, preserving tenant isolation and CAS", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-business-agent-policy.ts"], { encoding: "utf8", cwd: process.cwd() });
  expect(JSON.parse(output.trim())).toEqual({ reopened: true, isolated: true, conflictsProtected: true, runtimeConsumed: true });
});
