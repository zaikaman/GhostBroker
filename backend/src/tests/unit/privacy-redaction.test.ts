import { describe, expect, it } from "vitest";
import { redactForbiddenOrderFields } from "../../logging/logger.js";
import { scanForbiddenFields } from "../../privacy/forbidden-fields.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { redactTelemetryEvent } from "../../websocket/redact-event.js";
import type { TelemetryEvent } from "../../websocket/telemetry-event.js";

const safeTelemetryEvent: TelemetryEvent = {
  eventId: "evt_foundation",
  institutionId: "00000000-0000-4000-8000-000000000001",
  type: "telemetry.processing.changed",
  phase: "intent_sealed",
  severity: "info",
  timestamp: "2026-06-12T00:00:00.000Z",
  correlationRef: "corr_foundation",
};

describe("privacy redaction", () => {
  it("redacts forbidden order fields from structured log payloads", () => {
    const redacted = redactForbiddenOrderFields({
      correlationRef: "corr_foundation",
      nested: {
        asset: "SHOULD_NOT_LEAK",
        quantity: "SHOULD_NOT_LEAK",
        allowed: "retained",
      },
    });

    expect(redacted).toEqual({
      correlationRef: "corr_foundation",
      nested: {
        asset: "[REDACTED]",
        quantity: "[REDACTED]",
        allowed: "retained",
      },
    });
    expect(scanForbiddenFields(redacted)).toHaveLength(2);
  });

  it("rejects telemetry events that contain forbidden order fields", () => {
    const unsafeEvent = {
      ...safeTelemetryEvent,
      asset: "SHOULD_NOT_LEAK",
    };

    expect(() =>
      redactTelemetryEvent(unsafeEvent),
    ).toThrow(/Forbidden order fields detected/);
  });

  it("publishes only allowlisted telemetry fields", () => {
    const bus = new TelemetryBus();
    const received: TelemetryEvent[] = [];
    bus.subscribe((event) => {
      received.push(event);
    });

    const published = bus.publish({
      ...safeTelemetryEvent,
      receiptRef: "receipt_opaque",
    });

    expect(received).toHaveLength(1);
    expect(published.receiptRef).toBe("receipt_opaque");
    expect(Object.keys(published).sort()).toEqual(
      [
        "correlationRef",
        "eventId",
        "institutionId",
        "phase",
        "receiptRef",
        "severity",
        "timestamp",
        "type",
      ].sort(),
    );
  });
});
