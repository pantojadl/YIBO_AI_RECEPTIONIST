import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerDemoRoutes } from "../../src/api/routes/demo.js";

describe("synthetic demo page", () => {
  it("serves a simulation and a status that does not claim a live service", async () => {
    const server = Fastify({ logger: false });
    await registerDemoRoutes(server);
    const page = await server.inject({ method: "GET", url: "/demo" });
    const status = await server.inject({ method: "GET", url: "/demo/status" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("SIMULATION");
    expect(page.body).toContain("DEMO READY");
    expect(page.body).toContain("automated AI assistant");
    expect(page.body).toContain("not being recorded");
    expect(page.body).toContain("not a HIPAA product");
    expect(page.body).toContain("inbound");
    expect(page.body).not.toContain("sk-");
    expect(status.json()).toMatchObject({
      status: "DEMO_READY",
      pilotReady: false,
      productionReady: false,
      inboundOnly: true,
      callRecording: false,
      hipaaClaim: false,
      livePstnVerified: false,
      paidModelCalls: false,
    });
    await server.close();
  });
});
