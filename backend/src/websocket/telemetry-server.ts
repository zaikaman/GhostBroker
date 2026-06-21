import { parse as parseUrl } from "node:url";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TelemetryBus } from "../services/telemetry-bus.js";

/**
 * Heroku terminates idle HTTP connections after 55 seconds (H15).
 * Keepalive pings every 25 seconds prevent this timeout for
 * long-lived WebSocket telemetry channels.
 */
const WS_KEEPALIVE_INTERVAL_MS = 25_000;

function getInstitutionId(request: IncomingMessage): string | undefined {
  // 1. Check HTTP headers (used by server-side or proxy-to-server connections)
  const header =
    request.headers["x-operator-institution-id"] ?? request.headers["x-institution-id"];

  if (header) {
    return Array.isArray(header) ? header[0]?.trim() : header.trim();
  }

  // 2. Check URL query parameters (used by browser WebSocket connections
  //    which cannot set custom headers)
  const parsed = parseUrl(request.url ?? "", true);
  const queryParam =
    (parsed.query["institutionId"] as string | undefined) ??
    (parsed.query["token"] as string | undefined);

  return queryParam?.trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export function attachTelemetryServer(
  server: HttpServer,
  bus: TelemetryBus,
): WebSocketServer {
  const websocketServer = new WebSocketServer({
    server,
    path: "/ws/telemetry",
  });

  websocketServer.on("connection", (socket: WebSocket, request) => {
    const institutionId = getInstitutionId(request);

    if (!institutionId || !isUuid(institutionId)) {
      socket.close(1008, "authorization_failed");
      return;
    }

    if (process.env.NODE_ENV !== "test") {
      const timestamp = new Date().toISOString();
      const initialPhases = [
        "backend_connected",
        "websocket_connected",
        "supabase_connected",
        "t3_sandbox_connected",
      ] as const;

      for (const phase of initialPhases) {
        socket.send(
          JSON.stringify({
            eventId: `evt_${phase}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            institutionId,
            type: "telemetry.connection.changed",
            phase,
            severity: "info",
            timestamp,
            correlationRef: "",
          }),
        );
      }
    }

    const unsubscribe = bus.subscribe((event) => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }

      if (institutionId && event.institutionId !== institutionId) {
        return;
      }

      socket.send(JSON.stringify(event));
    });

    socket.on("close", unsubscribe);

    // --- Keepalive: prevent Heroku H15 idle-connection timeouts ---
    // Heroku's router terminates HTTP connections that have been idle
    // for 55 seconds (H15). The telemetry channel sends events only
    // when something changes (agent status, settlement events), so
    // long idle periods are normal. A 25-second ping interval keeps
    // the connection alive without adding meaningful overhead.
    const keepaliveHandle = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, WS_KEEPALIVE_INTERVAL_MS);

    socket.on("close", () => {
      clearInterval(keepaliveHandle);
    });
  });

  return websocketServer;
}
