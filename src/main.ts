import "dotenv/config";
import { buildConfiguredApplication } from "./bootstrap/build-configured-application.js";
import { acquireInstanceLock } from "./bootstrap/instance-lock.js";
import { createApiServer } from "./api/index.js";

const releaseInstanceLock = process.env.YIBO_INSTANCE_LOCK === "1"
  ? acquireInstanceLock(process.env.YIBO_INSTANCE_LOCK_PATH?.trim() || "data/yibo-instance.lock")
  : undefined;

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

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await application.telephony.close?.();
  await server.close();
  releaseInstanceLock?.();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
