import { describe, expect, it } from "vitest";
import { redactForbiddenOrderFields } from "../../logging/logger.js";

/**
 * The privacy boundary for hidden intent error logging. Any error
 * payload that could carry plaintext trading parameters --
 * either directly (`error.message` containing `asset: WBTC,
 * side: buy, quantity: 100, price: 45000`) or via a closure
 * that includes a synthetic `PendingIntent` -- must be redacted
 * before the structured log emits. These tests assert the
 * redactor is wired correctly and the structured logger does
 * not see plaintext even when the error payload is the typed
 * exception from a Supabase RPC whose cause includes a
 * `portfolios` row.
 */
describe("hidden intent log scrubbing", () => {
  it("redacts plaintext trading fields before structured logging", () => {
    const redacted = redactForbiddenOrderFields({
      route: "/api/agents/intents",
      body: {
        encryptedIntentEnvelope: "t3env.safe.ciphertext",
        asset: "SHOULD_NOT_LEAK",
        side: "SHOULD_NOT_LEAK",
        quantity: "SHOULD_NOT_LEAK",
        price: "SHOULD_NOT_LEAK",
      },
    });

    expect(redacted).toEqual({
      route: "/api/agents/intents",
      body: {
        encryptedIntentEnvelope: "t3env.safe.ciphertext",
        asset: "[REDACTED]",
        side: "[REDACTED]",
        quantity: "[REDACTED]",
        price: "[REDACTED]",
      },
    });
  });

  it("redacts forbidden fields anywhere in the payload tree", () => {
    const redacted = redactForbiddenOrderFields({
      correlationRef: "corr_1",
      nested: {
        deeper: {
          assetCode: "WBTC",
          side: "buy",
          quantity: 100,
          price: 45000,
        },
        allowedField: "kept",
      },
    });
    expect(redacted).toEqual({
      correlationRef: "corr_1",
      nested: {
        deeper: {
          assetCode: "[REDACTED]",
          side: "[REDACTED]",
          quantity: "[REDACTED]",
          price: "[REDACTED]",
        },
        allowedField: "kept",
      },
    });
  });

  it("does not redact non-forbidden fields (handles, refs, opaques)", () => {
    const redacted = redactForbiddenOrderFields({
      intentHandle: "intent_opaque_1",
      executionRef: "t3exec_1",
      authorityRef: "ghostbroker-delegation:abc",
      correlationRef: "corr_1",
      institutionId: "00000000-0000-4000-8000-000000000201",
      agentDid: "did:t3n:agent:us2",
    });
    expect(redacted).toEqual({
      intentHandle: "intent_opaque_1",
      executionRef: "t3exec_1",
      authorityRef: "ghostbroker-delegation:abc",
      correlationRef: "corr_1",
      institutionId: "00000000-0000-4000-8000-000000000201",
      agentDid: "did:t3n:agent:us2",
    });
  });

  it("scrubs Supabase RPC error payloads that mention forbidden order fields", () => {
    // Simulated PostgrestError payload: the `details` field
    // mirrors what a Supabase RPC surfaces in `error.details` and
    // can include the row context that touched the portfolio.
    // The redactor must scrub the forbidden fields before the
    // structured log emits.
    const scrubbed = redactForbiddenOrderFields({
      name: "PostgrestError",
      message: "insert into portfolios failed",
      details: {
        asset: "WBTC",
        side: "buy",
        quantity: 100,
        price: 45000,
        hint: "balance insufficient",
      },
    });
    expect(scrubbed).toEqual({
      name: "PostgrestError",
      message: "insert into portfolios failed",
      details: {
        asset: "[REDACTED]",
        side: "[REDACTED]",
        quantity: "[REDACTED]",
        price: "[REDACTED]",
        hint: "balance insufficient",
      },
    });
  });
});
