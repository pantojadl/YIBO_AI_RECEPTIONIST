import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps a pending SQLite confirmation from being booked again", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-pending-slot.ts"], {
    encoding: "utf8", cwd: process.cwd(),
  });
  expect(output.trim()).toBe("pending slot occupies until failed");
});
