import { describe, expect, it } from "vitest";
import { redactForbiddenOrderFields, redactLogTail } from "../../logging/logger.js";

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

/**
 * The `redactLogTail` helper is the wire-side guarantee that any
 * plaintext trading parameter emitted by the hosted-agent child
 * process is scrubbed before reaching the dashboard's
 * AgentDeploymentGuide logTail panel. The child is outside the
 * backend's structured-logging boundary, so the helper has to handle
 * both JSON dumps (hosted-agent.ts `console.log(JSON.stringify(...))`)
 * and free-form `key=value` style fragments (legacy
 * `Decision propose qty=1.5 price=70000` lines).
 */
describe("redactLogTail — hosted-agent logTail redaction", () => {
  it("redacts forbidden fields in JSON-formatted child chunks", () => {
    const chunk = JSON.stringify({
      outcome: "settled",
      lastDecision: { action: "propose", price: 70000, quantity: 1.5 },
      settlementCorrelationRef: "settle-opaque",
    });
    const scrubbed = redactLogTail(chunk);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("70000");
    expect(scrubbed).not.toContain("1.5");
    // Allowed handles and refs survive.
    expect(scrubbed).toContain("settle-opaque");
    expect(scrubbed).toContain('"outcome":"settled"');
  });

  it("redacts key=value fragments in free-form child chunks", () => {
    const scrubbed = redactLogTail(
      "[2026-01-01T00:00:00.000Z] [BUY  ] Decision propose qty=1.5 price=70000 (Open at anchor)",
    );
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("70000");
    expect(scrubbed).not.toContain("1.5");
    // Allowed content survives.
    expect(scrubbed).toContain("Decision propose");
    expect(scrubbed).toContain("Open at anchor");
  });

  it("redacts camelCase forbidden keys (qty, bidPrice, executionPrice)", () => {
    const scrubbed = redactLogTail(
      "buyer bidPrice=45000.5 sellQuantity=2 executionPrice=45001",
    );
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("45000.5");
    expect(scrubbed).not.toContain("45001");
  });

  it("redacts JSON-style colon-separated forbidden keys", () => {
    const scrubbed = redactLogTail(
      'submit rejected 422 (action="propose" price: 70000 quantity: 1.5)',
    );
    expect(scrubbed).not.toContain("70000");
    expect(scrubbed).not.toContain("1.5");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("preserves chunks that contain no forbidden fields", () => {
    const safe = "[2026-01-01T00:00:00.000Z] [BUY  ] Tick 1/40 (start of run)";
    expect(redactLogTail(safe)).toBe(safe);
  });

  it("tolerates Buffer input and empty chunks", () => {
    expect(redactLogTail("")).toBe("");
    expect(redactLogTail(Buffer.from(""))).toBe("");
    expect(redactLogTail(null)).toBe("");
    expect(redactLogTail(undefined)).toBe("");
    const buf = Buffer.from(
      "Move rejected 422 (action=propose price=70000 qty=1.5)",
      "utf8",
    );
    const scrubbed = redactLogTail(buf);
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("70000");
    expect(scrubbed).not.toContain("1.5");
  });

  it("does not redact substring occurrences inside unrelated identifiers (best-effort)", () => {
    // "price" appears inside "strikePrice" — `\b` boundaries ensure
    // we do NOT redact the surrounding value as if "price" alone
    // were a forbidden key. This protects allowed refs (e.g. an
    // opaque handle containing "price") from over-redaction.
    const line = "policyRef: settlement-price-band-wbtc verdict: open";
    expect(redactLogTail(line)).toBe(line);
  });
});
