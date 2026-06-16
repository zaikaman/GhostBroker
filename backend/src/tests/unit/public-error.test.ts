import { describe, expect, it } from "vitest";
import { PublicError } from "../../errors/public-error.js";

describe("PublicError.toResponse", () => {
  it("exposes a `cause` field for service_unavailable when the cause is an Error", () => {
    const cause = new Error("T3 sandbox is offline");
    const error = new PublicError("service_unavailable", 503, cause);
    expect(error.toResponse()).toEqual({
      code: "service_unavailable",
      message: "The service is temporarily unavailable.",
      cause: "T3 sandbox is offline",
    });
  });

  it("exposes a `cause` field for sealing_failed when the cause is an Error", () => {
    const cause = new Error(
      "T3N tenant contract 'matching' is not registered for this tenant.",
    );
    const error = new PublicError("sealing_failed", 503, cause);
    expect(error.toResponse()).toEqual({
      code: "sealing_failed",
      message: "The intent could not be sealed by the T3 enclave.",
      cause: "T3N tenant contract 'matching' is not registered for this tenant.",
    });
  });

  it("omits the `cause` field for sealing_failed when there is no Error cause", () => {
    const error = new PublicError("sealing_failed", 503);
    const response = error.toResponse();
    expect(response).toEqual({
      code: "sealing_failed",
      message: "The intent could not be sealed by the T3 enclave.",
    });
    expect("cause" in response).toBe(false);
  });

  it("does NOT expose the `cause` field for authorization_failed (to avoid leaking trust-bundle detail)", () => {
    const cause = new Error("internal reason: VC signature chain invalid");
    const error = new PublicError("authorization_failed", 403, cause);
    const response = error.toResponse();
    expect(response).toEqual({
      code: "authorization_failed",
      message: "The requested action is not authorized.",
    });
    expect("cause" in response).toBe(false);
  });

  it("does NOT expose the `cause` field for validation_failed (to avoid leaking schema detail)", () => {
    const cause = new Error("internal reason: missing required field 'encryptedIntentEnvelope'");
    const error = new PublicError("validation_failed", 400, cause);
    const response = error.toResponse();
    expect(response).toEqual({
      code: "validation_failed",
      message: "The request could not be accepted.",
    });
    expect("cause" in response).toBe(false);
  });

  it("allows a custom public message without exposing the internal cause for validation_failed", () => {
    const cause = new Error("internal reason: insufficient funds for transfer");
    const error = new PublicError(
      "validation_failed",
      422,
      cause,
      "Deposit wallet needs Sepolia ETH for gas.",
    );

    expect(error.toResponse()).toEqual({
      code: "validation_failed",
      message: "Deposit wallet needs Sepolia ETH for gas.",
    });
  });

  it("does NOT expose the `cause` field for not_found (no internal context to leak)", () => {
    const cause = new Error("internal reason: no row for institutionId=...");
    const error = new PublicError("not_found", 404, cause);
    const response = error.toResponse();
    expect(response).toEqual({
      code: "not_found",
      message: "The requested resource was not found.",
    });
    expect("cause" in response).toBe(false);
  });

  it("omits the `cause` field for service_unavailable when the cause is a non-Error value", () => {
    const error = new PublicError("service_unavailable", 503, "plain string cause");
    const response = error.toResponse();
    expect(response).toEqual({
      code: "service_unavailable",
      message: "The service is temporarily unavailable.",
    });
    expect("cause" in response).toBe(false);
  });
});
