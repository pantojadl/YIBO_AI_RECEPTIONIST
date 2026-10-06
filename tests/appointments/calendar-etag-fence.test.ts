import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Codex calendar etag interleaving", () => {
  it("does not let a stale reschedule overwrite the committed Google event", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-calendar-etag-fence.ts"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    const line = output.trim().split("\n").find((entry) => entry.startsWith("{") && entry.includes("\"aligned\""));
    expect(JSON.parse(line ?? "")).toMatchObject({ aligned: true, patches: 0, staleCode: "NEEDS_RECONCILE", writerBCommitted: false });
  });
});
