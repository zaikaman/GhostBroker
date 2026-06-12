import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { attachTelemetryServer } from "../../websocket/telemetry-server.js";
import type { TelemetryEvent } from "../../websocket/telemetry-event.js";
import {
  us3BuyerInstitutionId,
  us3UnrelatedInstitutionId,
} from "../data/us3-settlement-builders.js";

let activeServer: Server | undefined;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<TelemetryEvent> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()) as TelemetryEvent);
    });
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => {
      resolve(code);
    });
  });
}

async function createTelemetrySocket(
  port: number,
  institutionId: string,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/telemetry`, {
    headers: {
      "x-operator-institution-id": institutionId,
    },
  });
  await waitForOpen(socket);
  return socket;
}

afterEach(() => {
  if (activeServer) {
    activeServer.close();
    activeServer = undefined;
  }
});

describe("websocket telemetry event contract", () => {
  it("emits only the documented event envelope to the authorized institution channel", async () => {
    const bus = new TelemetryBus();
    activeServer = createServer();
    const websocketServer = attachTelemetryServer(activeServer, bus);
    const port = await listen(activeServer);
    const buyerSocket = await createTelemetrySocket(port, us3BuyerInstitutionId);
    const unrelatedSocket = await createTelemetrySocket(
      port,
      us3UnrelatedInstitutionId,
    );
    const unrelatedMessages: string[] = [];
    unrelatedSocket.on("message", (data) => unrelatedMessages.push(data.toString()));
    const buyerMessage = waitForMessage(buyerSocket);

    bus.publish({
      eventId: "evt_contract_us4",
      institutionId: us3BuyerInstitutionId,
      type: "telemetry.processing.changed",
      phase: "receipt_available",
      severity: "info",
      timestamp: "2026-06-12T10:00:00.000Z",
      correlationRef: "corr_contract_us4",
      receiptRef: "receipt_contract_us4",
    });

    await expect(buyerMessage).resolves.toEqual({
      eventId: "evt_contract_us4",
      institutionId: us3BuyerInstitutionId,
      type: "telemetry.processing.changed",
      phase: "receipt_available",
      severity: "info",
      timestamp: "2026-06-12T10:00:00.000Z",
      correlationRef: "corr_contract_us4",
      receiptRef: "receipt_contract_us4",
    });
    expect(unrelatedMessages).toHaveLength(0);

    buyerSocket.close();
    unrelatedSocket.close();
    websocketServer.close();
  });

  it("closes telemetry sockets without an operator institution scope", async () => {
    const bus = new TelemetryBus();
    activeServer = createServer();
    const websocketServer = attachTelemetryServer(activeServer, bus);
    const port = await listen(activeServer);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/telemetry`);

    await waitForOpen(socket);

    await expect(waitForClose(socket)).resolves.toBe(1008);
    websocketServer.close();
  });
});
