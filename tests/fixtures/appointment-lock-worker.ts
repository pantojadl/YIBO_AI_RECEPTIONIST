import { openRegionalDatabase } from "../../src/infrastructure/database/regional-database.js";
import { SqliteAppointmentConcurrencyGuard } from "../../src/infrastructure/database/sqlite-appointment-concurrency-guard.js";
const [path, tenantId, locationId] = process.argv.slice(2);
if (!path || !tenantId || !locationId || !process.send) throw new Error("Synthetic worker arguments required");
const database = openRegionalDatabase("US", path);
try {
  await new SqliteAppointmentConcurrencyGuard(database, "US").execute(tenantId, locationId, "test", async () => {
    const released = new Promise<void>(resolve => process.once("message", () => resolve()));
    process.send!({ held: true }); await released;
  });
} finally { database.close(); process.disconnect?.(); }
