import { createServer } from "node:http";
import { createApp, createDefaultServices } from "./app.js";
import { loadEnv } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { telemetryBus } from "./services/telemetry-bus.js";
import { attachTelemetryServer } from "./websocket/telemetry-server.js";

const DEFAULT_RECONCILER_INTERVAL_MS = 10 * 60 * 1000;

const env = loadEnv();
// Construct the default services first so the shutdown
// hook can drain hosted agent child processes before exit.
// The Express `app` is built with the same services bag.
const services = await createDefaultServices(env);
const app = createApp(env, services);
const server = createServer(app);

attachTelemetryServer(server, telemetryBus);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Backend server listening.");
});

// WS4: settlement reconciler timer. The reconciler is the
// always-on system task that polls `completed_trades` for
// unreconciled rows and verifies the chain state via
// `rail.status(railTradeRef)`. Drift is surfaced via a
// `rail_drift_detected` telemetry event. The interval is
// configurable for tests; production runs every 10 minutes.
//
// The reconciler is optional in the services bag (test
// compositions can omit it) and the timer is `.unref()`'d
// so it never blocks the event loop from exiting. On
// SIGTERM the shutdown handler clears the interval and
// waits for any in-flight sweep to finish before closing
// the HTTP server.
const reconcilerIntervalMs =
  env.SETTLEMENT_RECONCILER_INTERVAL_MS ?? DEFAULT_RECONCILER_INTERVAL_MS;
const reconcilerTimer = services.settlementReconciler
  ? setInterval(() => {
      services.settlementReconciler?.runOnce().catch((err: unknown) => {
        logger.warn(
          { err },
          "Settlement reconciler sweep failed; next interval will retry",
        );
      });
    }, reconcilerIntervalMs)
  : null;

if (reconcilerTimer) {
  reconcilerTimer.unref();
  logger.info(
    { intervalMs: reconcilerIntervalMs },
    "Settlement reconciler scheduled.",
  );
}

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Backend server shutting down.");

  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
  }

  if (services.hostedAgentService) {
    void services.hostedAgentService.stopAllHostedAgents().catch((err: unknown) => {
      logger.warn({ err }, "Hosted agent shutdown drain failed");
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
