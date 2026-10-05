import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("launch integration migration on disposable copies", () => {
  it("upgrades Product UX v9 in both regions without changing source copies, historical appointments or saved rules", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-launch-migration.ts"], { encoding: "utf8", cwd: process.cwd() });
    expect(JSON.parse(output.trim())).toEqual({ copies: ["MX", "US"], sourceUnchanged: true, migration10Idempotent: true, migration11Idempotent: true,
      configurationPreserved: true, bothCalendarReads: true, customerHistoryAndNotifications: true });
  });
});
