import Fastify, { type FastifyInstance } from "fastify";
import type { YiboApplication } from "../bootstrap/index.js";
import { registerAgentConfigurationRoutes } from "./routes/agent-configuration.js";
import { registerAppointmentRoutes } from "./routes/appointments.js";
import { registerAvailabilityRoutes } from "./routes/availability.js";
import { registerBusinessRoutes } from "./routes/business.js";
import { registerBusinessServiceRoutes } from "./routes/business-services.js";
import { registerBusinessProfessionalRoutes } from "./routes/business-professionals.js";
import { registerSchedulingPolicyRoutes } from "./routes/scheduling-policies.js";
import { registerCalendarAssignmentRoutes } from "./routes/calendar-assignments.js";
import { registerTransferDestinationRoutes } from "./routes/transfer-destinations.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerGoogleCalendarRoutes } from "./routes/google-calendar.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerReadinessRoutes } from "./routes/readiness.js";
import { registerDemoRoutes } from "./routes/demo.js";

export async function createApiServer(app: YiboApplication): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await registerHealthRoutes(server);
  await registerDemoRoutes(server);
  await registerAuthRoutes(server, app);
  await registerReadinessRoutes(server, app);
  await registerAgentConfigurationRoutes(server, app);
  await registerBusinessRoutes(server, app);
  await registerBusinessServiceRoutes(server, app);
  await registerBusinessProfessionalRoutes(server, app);
  await registerSchedulingPolicyRoutes(server, app);
  await registerCalendarAssignmentRoutes(server, app);
  await registerTransferDestinationRoutes(server, app);
  await registerCustomerRoutes(server, app);
  await registerAvailabilityRoutes(server, app);
  await registerAppointmentRoutes(server, app);
  await registerGoogleCalendarRoutes(server, app);
  return server;
}
