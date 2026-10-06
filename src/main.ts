import "dotenv/config";
import { buildConfiguredApplication } from "./bootstrap/build-configured-application.js";
import { createApiServer } from "./api/index.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || "127.0.0.1";
const application = await buildConfiguredApplication({
  environment: process.env,
  enableAsteriskTelephony: true,
  ...(process.env.YIBO_TENANT_ID?.trim() ? { tenantId: process.env.YIBO_TENANT_ID.trim() } : {}),
});
const server = await createApiServer(application);

await server.listen({ port, host });
console.log(`YIBO API listening on ${host}:${port}`);
console.log(`Local tenant: ${application.tenantId}`);

const stuckBookingRecovery = setInterval(() => {
  void application.appointments.recoverStuckBookings(application.tenantId).catch(() => undefined);
}, 60_000);
stuckBookingRecovery.unref();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(stuckBookingRecovery);
  await application.telephony.close?.();
  await server.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
