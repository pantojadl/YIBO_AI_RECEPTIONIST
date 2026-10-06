import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { leaseIsExpired } from "../../src/modules/appointments/application/appointment-lock.js";

describe("appointment lock lease", () => {
  it("treats a refreshed heartbeat as live and a missed heartbeat as expired", () => {
    const now = 1_000_000;
    expect(leaseIsExpired(now, now + 3 * 60_000, 90_000)).toBe(true);
    expect(leaseIsExpired(now + 3 * 60_000, now + 3 * 60_000, 90_000)).toBe(false);
    expect(leaseIsExpired(now, now + 90_000, 90_000)).toBe(true);
  });

  it("keeps a heartbeating SQLite lock and rejects the old writer after a steal", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-live-lock.ts"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      heartbeatsHold: true,
      missedHeartbeatsSteal: true,
      staleFenceRejected: true,
    });
  });
});
