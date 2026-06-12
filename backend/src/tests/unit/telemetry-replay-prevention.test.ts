import { describe, expect, it } from "vitest";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { TelemetryEvent } from "../../websocket/telemetry-event.js";
import { us3BuyerInstitutionId } from "../data/us3-settlement-builders.js";

describe("telemetry replay prevention", () => {
  it("does not fan out repeated event ids or repeated correlation phase events", () => {
    const bus = new TelemetryBus();
    const received: TelemetryEvent[] = [];
    bus.subscribe((event) => received.push(event));

    const baseEvent = {
      institutionId: us3BuyerInstitutionId,
      type: "telemetry.processing.changed",
      phase: "settlement_finalized",
      severity: "info",
      correlationRef: "corr_replay_us4",
    } as const;

    bus.publish({
      ...baseEvent,
      eventId: "evt_replay_us4",
    });
    bus.publish({
      ...baseEvent,
      eventId: "evt_replay_us4",
    });
    bus.publish({
      ...baseEvent,
      eventId: "evt_replay_us4_second",
    });

    expect(received).toHaveLength(1);
  });
});
