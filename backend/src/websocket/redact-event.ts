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
  Partial<Pick<TelemetryEvent, "agentId" | "receiptRef">>;

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
