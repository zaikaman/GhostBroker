import { describe, expect, it } from "vitest";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import type { TelemetryEvent } from "../../websocket/telemetry-event.js";
import { us2AgentDid, us2InstitutionId } from "../data/us2-encrypted-intent-builders.js";

describe("hidden intent telemetry redaction", () => {
  it.each(["intent_received", "intent_sealed", "encrypted_evaluation"] as const)(
    "allows %s without leaking forbidden fields",
    (phase) => {
      const bus = new TelemetryBus();
      const received: TelemetryEvent[] = [];
      bus.subscribe((event) => received.push(event));

      const event = bus.publish({
        institutionId: us2InstitutionId,
        type: "telemetry.processing.changed",
        phase,
        severity: "info",
        correlationRef: "corr_us2",
        agentId: us2AgentDid,
      });

      expect(event.phase).toBe(phase);
      expect(received).toHaveLength(1);
      expect(Object.keys(event)).not.toContain("queueDepth");
    },
  );
});
