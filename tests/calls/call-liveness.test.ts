import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALL_ENDED_TTL_MS,
  configureCallLiveness,
  isCallEnded,
  markCallEnded,
  MemoryCallLivenessStore,
  restoreDefaultCallLiveness,
} from "../../src/modules/calls/index.js";

describe("shared hangup tracking", () => {
  afterEach(() => restoreDefaultCallLiveness());

  it("shares a hangup across database connections and drops it after the ttl", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "tests/fixtures/sqlite-call-liveness.ts"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ shared: true, expires: true, processStore: true });
  });

  it("expires an in-memory hangup and keeps a configured store until the process default is restored", () => {
    const memory = new MemoryCallLivenessStore();
    memory.markEnded("call", 0, CALL_ENDED_TTL_MS);
    expect(memory.isEnded("call", CALL_ENDED_TTL_MS - 1)).toBe(true);
    expect(memory.isEnded("call", CALL_ENDED_TTL_MS)).toBe(false);

    let now = 5_000;
    configureCallLiveness({ store: memory, now: () => now, ttlMs: 1_000 });
    markCallEnded("live");
    expect(isCallEnded("live")).toBe(true);
    now = 6_000;
    expect(isCallEnded("live")).toBe(false);
    restoreDefaultCallLiveness();
    expect(isCallEnded("live")).toBe(false);
    markCallEnded("private");
    expect(isCallEnded("private")).toBe(true);
    expect(memory.isEnded("private", Date.now())).toBe(false);
  });

  it("keeps a hangup mark past the ttl while a tool is still in flight", () => {
    const memory = new MemoryCallLivenessStore();
    memory.pin("call");
    memory.markEnded("call", 0, 1_000);
    expect(memory.isEnded("call", 5_000)).toBe(true);
    memory.unpin("call");
    expect(memory.isEnded("call", 5_000)).toBe(false);
  });
});
