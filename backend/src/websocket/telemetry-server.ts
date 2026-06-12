import { parse as parseUrl } from "node:url";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TelemetryBus } from "../services/telemetry-bus.js";

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
  });

  return websocketServer;
}
