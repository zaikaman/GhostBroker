import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TelemetryBus } from "../services/telemetry-bus.js";

function getInstitutionId(request: IncomingMessage): string | undefined {
  const header = request.headers["x-institution-id"];

  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
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
