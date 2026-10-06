import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase, openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { SqliteCallLivenessStore } from "../../src/infrastructure/database/sqlite-call-liveness-store.js";
import {
  configureCallLiveness,
  isCallEnded,
  markCallEnded,
  restoreDefaultCallLiveness,
} from "../../src/modules/calls/index.js";

const directory = mkdtempSync(join(tmpdir(), "yibo-hangup-"));
const path = join(directory, "hangups.sqlite");
const first = openRegionalDatabase("MX", path);
const second = openRegionalDatabase("MX", path);
migrateDatabase(first);
try {
  const writer = new SqliteCallLivenessStore(first);
  const reader = new SqliteCallLivenessStore(second);
  writer.markEnded("call-shared", 1_000, 500);
  assert.equal(reader.isEnded("call-shared", 1_499), true);
  assert.equal(reader.isEnded("call-shared", 1_500), false);
  assert.equal(writer.isEnded("call-shared", 1_600), false);

  configureCallLiveness({ store: new SqliteCallLivenessStore(first), now: () => 10_000, ttlMs: 1_000 });
  markCallEnded("call-a");
  assert.equal(isCallEnded("call-a"), true);
  configureCallLiveness({ store: new SqliteCallLivenessStore(second), now: () => 10_500, ttlMs: 1_000 });
  assert.equal(isCallEnded("call-a"), true);
  configureCallLiveness({ store: new SqliteCallLivenessStore(second), now: () => 11_000, ttlMs: 1_000 });
  assert.equal(isCallEnded("call-a"), false);

  restoreDefaultCallLiveness();
  markCallEnded("call-b");
  assert.equal(isCallEnded("call-b"), true);
  assert.equal(new SqliteCallLivenessStore(second).isEnded("call-b", Date.now() + 1), false);
  console.log(JSON.stringify({ shared: true, expires: true, processStore: true }));
} finally {
  restoreDefaultCallLiveness();
  first.close();
  second.close();
  rmSync(directory, { recursive: true, force: true });
}
