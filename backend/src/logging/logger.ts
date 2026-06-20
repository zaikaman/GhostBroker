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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Defensive scrubber for free-form log chunks streamed from a child
 * process (e.g. hosted-agent stdout/stderr). The child process is
 * outside the backend's structured-logging boundary, so we MUST scrub
 * any plaintext trading parameters before the chunk is appended to
 * `state.logTail` and returned through `GET /api/hosted-agents/:id`
 * to the dashboard's AgentDeploymentGuide logTail panel.
 *
 * The scrubber has two layers, in priority order:
 *
 *   1. JSON-aware redaction: if the chunk parses as a JSON object or
 *      array, the structured `redactForbiddenOrderFields` redactor is
 *      applied and the result is reserialized. This catches the
 *      `hosted-agent.ts:64` `console.log(JSON.stringify(result, ...))`
 *      dump without re-listing every forbidden key here.
 *   2. Regex-based scrubbing: for free-form text, matches the
 *      `forbiddenOrderFieldNames` allowlist (case-insensitive) as a
 *      standalone word followed by `=` or `:` and a value, and
 *      replaces the value with the `[REDACTED]` sentinel.
 *
 * The helper is intentionally best-effort: the source-of-truth fix
 * is to remove plaintext trading parameters from the child's
 * `console.log` calls in the first place. This scrubber is the wire
 * guarantee that any future regression in the child is caught before
 * it reaches an operator's dashboard.
 */
export function redactLogTail(chunk: string | Buffer | null | undefined): string {
  if (chunk === null || chunk === undefined) {
    return "";
  }
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (text.length === 0) {
    return text;
  }

  const trimmed = text.trim();
  const looksLikeJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const redacted = redactForbiddenOrderFields(parsed);
      const tail = text.slice(trimmed.length);
      return JSON.stringify(redacted) + tail;
    } catch {
      // Not valid JSON; fall through to the regex scrubber.
    }
  }

  const sortedFields = [...forbiddenOrderFieldNames].sort(
    (left, right) => right.length - left.length,
  );
  const alternation = sortedFields.map(escapeRegExp).join("|");
  const scrubber = new RegExp(
    `(['"]?\\b(?:${alternation})\\b['"]?\\s*[:=]\\s*)` +
      `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;)}\\]]+)`,
    "giu",
  );
  return text.replace(scrubber, `$1${redactedValue}`);
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
