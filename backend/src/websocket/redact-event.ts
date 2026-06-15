import {
  assertNoForbiddenFields,
  scanForbiddenFields,
} from "../privacy/forbidden-fields.js";
import type { TelemetryEvent } from "./telemetry-event.js";

const allowedKeys = new Set<keyof TelemetryEvent>([
  "eventId",
  "institutionId",
  "type",
  "phase",
  "severity",
  "timestamp",
  "correlationRef",
  "agentId",
  "receiptRef",
  // WS1: rail transport proof. Carries only the rail id and the
  // rail-specific transport ref (a chain tx hash for the chain
  // rail, a custody ref for the custody rail, a `noop:<sha256>`
  // for the noop rail). The full `RailSettlementProof` is
  // intentionally NOT included because it would carry
  // `assetMovements` on the operator websocket, violating the
  // `telemetry-settlement-redaction.test.ts` invariant that no
  // settlement-phase payload contain plaintext asset/quantity/price
  // substrings.
  "railProofRef",
  // WS4: rail dispatch latency in milliseconds. Numeric value;
  // the allow-list permits it through the websocket
  // redaction filter.
  "latencyMs",
]);

export type RedactedTelemetryEvent = Pick<
  TelemetryEvent,
  | "eventId"
  | "institutionId"
  | "type"
  | "phase"
  | "severity"
  | "timestamp"
  | "correlationRef"
> &
  Partial<Pick<TelemetryEvent, "agentId" | "receiptRef" | "railProofRef" | "latencyMs">>;

export function redactTelemetryEvent(
  event: TelemetryEvent & object,
): RedactedTelemetryEvent {
  const forbiddenFindings = scanForbiddenFields(event);

  if (forbiddenFindings.length > 0) {
    assertNoForbiddenFields(event);
  }

  const redacted: Partial<RedactedTelemetryEvent> = {};

  for (const [key, value] of Object.entries(event)) {
    if (allowedKeys.has(key as keyof TelemetryEvent)) {
      Object.assign(redacted, { [key]: value });
    }
  }

  return redacted as RedactedTelemetryEvent;
}
