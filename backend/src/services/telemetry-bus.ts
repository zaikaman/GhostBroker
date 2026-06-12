import { randomUUID } from "node:crypto";
import type {
  TelemetryEvent,
  TelemetryEventInput,
} from "../websocket/telemetry-event.js";
import { redactTelemetryEvent } from "../websocket/redact-event.js";

export type TelemetryListener = (event: TelemetryEvent) => void;

export class TelemetryBus {
  private readonly listeners = new Set<TelemetryListener>();

  public publish(input: TelemetryEventInput): TelemetryEvent {
    const event: TelemetryEvent = {
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
      eventId: input.eventId || randomUUID(),
    };

    const safeEvent: TelemetryEvent = redactTelemetryEvent(event);

    for (const listener of this.listeners) {
      listener(safeEvent);
    }

    return safeEvent;
  }

  public subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

export const telemetryBus = new TelemetryBus();
