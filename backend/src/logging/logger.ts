import pino, { type Logger } from "pino";
import { forbiddenOrderFieldNames, isForbiddenOrderField } from "../privacy/forbidden-fields.js";

const redactedValue = "[REDACTED]";

function redactNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isForbiddenOrderField(key) ? redactedValue : redactNode(child),
    ]),
  );
}

export function redactForbiddenOrderFields<T>(value: T): T {
  return redactNode(value) as T;
}

export function createLogger(name = "ghostbroker-backend"): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: forbiddenOrderFieldNames.map((field) => `*.${field}`),
      censor: redactedValue,
      remove: false,
    },
    serializers: {
      req(request: unknown) {
        return redactForbiddenOrderFields(request);
      },
      res(response: unknown) {
        return redactForbiddenOrderFields(response);
      },
      err(error: unknown) {
        return redactForbiddenOrderFields(error);
      },
    },
  });
}

export const logger = createLogger();
