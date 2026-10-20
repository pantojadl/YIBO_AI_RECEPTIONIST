import { describe, expect, it } from "vitest";
import { dateTimeInTimezone, normalizeDateTimeForTimezone } from "../../src/modules/scheduling/domain/time.js";

describe("clinic timezone datetime normalization", () => {
  it("treats a bare 3:00 PM as clinic local time, not host or UTC time", () => {
    const instant = normalizeDateTimeForTimezone("2026-08-24T15:00", "America/Chicago");
    expect(instant?.toISOString()).toBe("2026-08-24T20:00:00.000Z");
    expect(dateTimeInTimezone(instant!, "America/Chicago")).toEqual({
      dateTime: "2026-08-24T15:00:00-05:00", timeZone: "America/Chicago",
    });
  });

  it("preserves an offset-aware slot instead of converting it a second time", () => {
    const instant = normalizeDateTimeForTimezone("2026-08-24T15:00:00-05:00", "America/Chicago");
    expect(instant?.toISOString()).toBe("2026-08-24T20:00:00.000Z");
  });

  it.each([
    ["9:00 AM", "2026-08-24T09:00", "2026-08-24T14:00:00.000Z", "2026-08-24T09:00:00-05:00"],
    ["noon", "2026-08-24T12:00", "2026-08-24T17:00:00.000Z", "2026-08-24T12:00:00-05:00"],
    ["3:00 PM", "2026-08-24T15:00", "2026-08-24T20:00:00.000Z", "2026-08-24T15:00:00-05:00"],
    ["3:45 PM", "2026-08-24T15:45", "2026-08-24T20:45:00.000Z", "2026-08-24T15:45:00-05:00"],
    ["midnight", "2026-08-24T00:00", "2026-08-24T05:00:00.000Z", "2026-08-24T00:00:00-05:00"],
    ["a quarter past", "2026-08-24T10:15", "2026-08-24T15:15:00.000Z", "2026-08-24T10:15:00-05:00"],
    ["half past", "2026-08-24T10:30", "2026-08-24T15:30:00.000Z", "2026-08-24T10:30:00-05:00"],
  ])("round-trips %s without changing the caller's local time", (_label, local, utc, googleDateTime) => {
    const instant = normalizeDateTimeForTimezone(local, "America/Chicago");
    expect(instant?.toISOString()).toBe(utc);
    expect(dateTimeInTimezone(instant!, "America/Chicago").dateTime).toBe(googleDateTime);
  });

  it("uses the correct daylight-saving offset for the same local time", () => {
    expect(normalizeDateTimeForTimezone("2026-03-08T15:00", "America/Denver")?.toISOString())
      .toBe("2026-03-08T21:00:00.000Z");
    expect(normalizeDateTimeForTimezone("2026-11-01T15:00", "America/Denver")?.toISOString())
      .toBe("2026-11-01T22:00:00.000Z");
  });

  it("keeps morning appointments on the spring-forward and fall-back days", () => {
    const spring = normalizeDateTimeForTimezone("2026-03-08T07:00", "America/Chicago");
    expect(spring?.toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(dateTimeInTimezone(spring!, "America/Chicago").dateTime).toBe("2026-03-08T07:00:00-05:00");

    const autumn = normalizeDateTimeForTimezone("2026-11-01T02:00", "America/Chicago");
    expect(autumn?.toISOString()).toBe("2026-11-01T08:00:00.000Z");
    expect(dateTimeInTimezone(autumn!, "America/Chicago").dateTime).toBe("2026-11-01T02:00:00-06:00");
  });

  it("rejects the local hour that daylight saving skips", () => {
    expect(normalizeDateTimeForTimezone("2026-03-08T02:30", "America/Chicago")).toBeNull();
  });

  it.each([
    ["daylight saving time", "2026-06-15T15:00", "2026-06-15T20:00:00.000Z", "2026-06-15T15:00:00-05:00"],
    ["standard time", "2026-12-15T15:00", "2026-12-15T21:00:00.000Z", "2026-12-15T15:00:00-06:00"],
  ])("uses IANA rules during %s", (_season, local, utc, localWithOffset) => {
    const instant = normalizeDateTimeForTimezone(local, "America/Chicago");
    expect(instant?.toISOString()).toBe(utc);
    expect(dateTimeInTimezone(instant!, "America/Chicago").dateTime).toBe(localWithOffset);
  });
});
