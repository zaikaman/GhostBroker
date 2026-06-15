import { createServer } from "node:http";
import { createApp, createDefaultServices } from "./app.js";
import { loadEnv } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { telemetryBus } from "./services/telemetry-bus.js";
import { attachTelemetryServer } from "./websocket/telemetry-server.js";

const env = loadEnv();
// Construct the default services first so the shutdown
// hook has a handle to the demo orchestrator (Phase 2.5).
// The Express `app` is built with the same services bag.
const services = await createDefaultServices(env);
const app = createApp(env, services);
const server = createServer(app);

attachTelemetryServer(server, telemetryBus);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Backend server listening.");
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Backend server shutting down.");

  // Phase 2.5: stop any running demo child processes
  // before we close the HTTP server. Without this, a
  // SIGTERM in the middle of a demo leaves the buyer
  // and seller agents orphaned. The orchestrator's
  // `stopDemo()` is idempotent — safe to call when
  // nothing is running.
  if (services.demoAgentOrchestrator) {
    void services.demoAgentOrchestrator.stopDemo().catch((err: unknown) => {
      logger.warn({ err }, "Demo orchestrator stop failed during shutdown");
    });
  }

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Backend server shutdown failed.");
      process.exitCode = 1;
    }

    process.exit();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
