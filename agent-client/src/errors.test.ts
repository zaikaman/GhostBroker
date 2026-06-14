import { describe, expect, it } from "vitest";
import { GhostBrokerApiError } from "./errors.js";

describe("GhostBrokerApiError", () => {
  it("exposes status, code, and message", () => {
    const err = new GhostBrokerApiError(401, "authorization_failed", "missing key");
    expect(err.status).toBe(401);
    expect(err.code).toBe("authorization_failed");
    expect(err.message).toBe("missing key");
    expect(err.name).toBe("GhostBrokerApiError");
  });

  it("flags 401 and 403 as auth errors", () => {
    expect(new GhostBrokerApiError(401, "authorization_failed", "").isAuthError).toBe(true);
    expect(new GhostBrokerApiError(403, "authorization_failed", "").isAuthError).toBe(true);
    expect(new GhostBrokerApiError(400, "validation_failed", "").isAuthError).toBe(false);
    expect(new GhostBrokerApiError(500, "service_unavailable", "").isAuthError).toBe(false);
  });

  it("flags 503 and any 5xx as retryable", () => {
    expect(new GhostBrokerApiError(503, "service_unavailable", "").isRetryable).toBe(true);
    expect(new GhostBrokerApiError(500, "service_unavailable", "").isRetryable).toBe(true);
    expect(new GhostBrokerApiError(502, "service_unavailable", "").isRetryable).toBe(true);
    expect(new GhostBrokerApiError(400, "validation_failed", "").isRetryable).toBe(false);
    expect(new GhostBrokerApiError(404, "not_found", "").isRetryable).toBe(false);
  });

  it("falls back to 'request_failed' for unparseable codes", () => {
    const err = new GhostBrokerApiError(500, "request_failed", "boom");
    expect(err.code).toBe("request_failed");
  });
});
