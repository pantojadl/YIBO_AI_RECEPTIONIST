import { describe, expect, it } from "vitest";
import { operationalRecord } from "../../src/shared/observability/operational-log.js";

describe("operationalRecord", () => {
  it("drops token-shaped strings instead of copying them into a log record", () => {
    const record = operationalRecord("calendar.booking.completed", {
      phase: "completed",
      code: "bearer ya29.not-a-live-token",
      tool: "access_token=not-a-live-token",
      metric: "client_secret",
      note: "refresh_token=not-a-live-token",
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(/ya29\.|not-a-live-token|refresh_token|access_token|client_secret|bearer/i);
    expect(record).toMatchObject({ event: "calendar.booking.completed", phase: "completed" });
    expect(record).not.toHaveProperty("code");
    expect(record).not.toHaveProperty("tool");
    expect(record).not.toHaveProperty("metric");
    expect(record).not.toHaveProperty("note");
  });
});
