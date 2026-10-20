import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/bootstrap/instance-lock.js";

const temps: string[] = [];

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("single-instance lock", () => {
  it("blocks a second live process on this host and replaces a foreign lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "yibo-lock-"));
    temps.push(dir);
    const lockPath = join(dir, "yibo.lock");
    const release = acquireInstanceLock(lockPath);
    expect(() => acquireInstanceLock(lockPath)).toThrow(/one instance only/);
    release();

    writeFileSync(lockPath, `other-host ${process.pid}\n`);
    const replaced = acquireInstanceLock(lockPath);
    replaced();
    expect(hostname()).not.toBe("other-host");
  });
});
