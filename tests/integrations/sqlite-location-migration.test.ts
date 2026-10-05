import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("SQLite location context migration", () => {
  it("upgrades a v4 database idempotently and backfills existing records", () => {
    const output = execFileSync(process.execPath, [
      "--import", "tsx", "tests/fixtures/sqlite-location-migration.ts",
    ], { encoding: "utf8", cwd: process.cwd() });
    const result = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(result).toMatchObject({
      calledNumber: { phone: "+529991234567", location_id: "default" },
      call: { call_id: "call-1", location_id: "default" },
      appointment: {
        id: "appointment-1", location_id: "default", service_name_snapshot: "service-1",
        price_amount_minor: 0, price_currency: "MXN",
      },
      counts: { calledNumbers: 1, calls: 1, appointments: 1 },
      freshColumns: {
        businesses: expect.arrayContaining(["configuration_version"]),
        called_numbers: expect.arrayContaining(["location_id"]),
        calls: expect.arrayContaining(["location_id"]),
        appointments: expect.arrayContaining(["location_id"]),
      },
    });
    expect(result.freshColumns).toMatchObject({
      appointments: expect.arrayContaining(["service_name_snapshot", "price_amount_minor", "price_currency"]),
    });
    expect(result.versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((version) => ({ version })));
  });
});
