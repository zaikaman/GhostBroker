import { randomUUID } from "node:crypto";
import type {
  TelemetryEvent,
  TelemetryEventInput,
} from "../websocket/telemetry-event.js";
import { redactTelemetryEvent } from "../websocket/redact-event.js";

export type TelemetryListener = (event: TelemetryEvent) => void;

interface ReplayRecord {
  eventId: string;
  replayKey: string;
}

export class TelemetryBus {
  private readonly listeners = new Set<TelemetryListener>();

  private readonly publishedEventIds = new Set<string>();

  private readonly publishedCorrelationRefs = new Set<string>();

  private readonly replayRecords: ReplayRecord[] = [];

  private readonly maxReplayRecords: number;

  public constructor(maxReplayRecords = 10_000) {
    this.maxReplayRecords = maxReplayRecords;
  }

  public publish(input: TelemetryEventInput): TelemetryEvent {
    const event: TelemetryEvent = {
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
      eventId: input.eventId || randomUUID(),
    };

    const safeEvent: TelemetryEvent = redactTelemetryEvent(event);
    const replayKey = this.buildReplayKey(safeEvent);

    if (
      this.publishedEventIds.has(safeEvent.eventId) ||
      this.publishedCorrelationRefs.has(replayKey)
    ) {
      return safeEvent;
    }

    this.publishedEventIds.add(safeEvent.eventId);
    this.publishedCorrelationRefs.add(replayKey);
    this.replayRecords.push({ eventId: safeEvent.eventId, replayKey });
    this.pruneReplayRecords();

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

  private buildReplayKey(event: TelemetryEvent): string {
    return [
      event.institutionId,
      event.type,
      event.phase,
      event.correlationRef,
    ].join(":");
  }

  private pruneReplayRecords(): void {
    while (this.replayRecords.length > this.maxReplayRecords) {
      const expired = this.replayRecords.shift();

      if (!expired) {
        return;
      }

      this.publishedEventIds.delete(expired.eventId);
      this.publishedCorrelationRefs.delete(expired.replayKey);
    }
  }
}

export const telemetryBus = new TelemetryBus();
