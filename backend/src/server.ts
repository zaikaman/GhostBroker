import { createServer } from "node:http";
import { createProductionApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { telemetryBus } from "./services/telemetry-bus.js";
import { attachTelemetryServer } from "./websocket/telemetry-server.js";

const env = loadEnv();
const app = await createProductionApp(env);
const server = createServer(app);

attachTelemetryServer(server, telemetryBus);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Backend server listening.");
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Backend server shutting down.");

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
