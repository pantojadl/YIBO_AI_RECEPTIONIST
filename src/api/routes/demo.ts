import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const demoHtmlPath = fileURLToPath(new URL("../../../demo/index.html", import.meta.url));

export const DEMO_STATUS = {
  status: "DEMO_READY",
  pilotReady: false,
  productionReady: false,
  inboundOnly: true,
  callRecording: false,
  hipaaClaim: false,
  livePstnVerified: false,
  paidModelCalls: false,
  note: "Synthetic demonstration. No live carrier and no live model.",
} as const;

export function demoPageHtml(): string {
  return readFileSync(demoHtmlPath, "utf8");
}

export async function registerDemoRoutes(server: FastifyInstance): Promise<void> {
  server.get("/demo", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(demoPageHtml());
  });
  server.get("/demo/status", async () => DEMO_STATUS);
}
