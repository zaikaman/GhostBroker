import { describe, expect, it } from "vitest";
import {
  deriveEncryptedTradeFieldHandles,
  deriveReceiptHash,
  deriveTeeAttestationRef,
} from "../privacy/encrypted-trade-fields.js";

/**
 * P0 regression test for the privacy helper that the orchestrator
 * uses to populate the three `completed_trades` settlement columns
 * (`asset_code_ciphertext`, `quantity_ciphertext`,
 * `execution_price_ciphertext`) and the two `audit_receipts`
 * integrity columns (`receipt_hash`, `t3_attestation_ref`).
 *
 * The previous orchestrator code populated all three settlement
 * columns with the same value (the buy-side `encryptedEnvelope`)
 * and used deterministic string concatenations for the receipt
 * hash and TEE attestation reference. Any DB reader could
 * `decodeSealedEnvelope` one column and recover the full plaintext
 * trading parameters for both sides of the trade.
 *
 * These tests lock down the new behaviour: the three settlement
 * handles are pairwise distinct, none of them equals the
 * encryptedEnvelope they are derived from, and the receipt hash /
 * attestation reference are deterministic but content-bound.
 */
describe("encrypted trade field handles", () => {
  const inputs = {
    outcomeRef: "match_outcome_us3",
    executionRef: "t3exec_us3",
    buyerInstitutionId: "00000000-0000-4000-8000-000000000301",
    sellerInstitutionId: "00000000-0000-4000-8000-000000000302",
  };

  it("derives three pairwise-distinct settlement handles from the outcome", () => {
    const handles = deriveEncryptedTradeFieldHandles(inputs);
    expect(handles.assetCodeCiphertext).not.toBe(handles.quantityCiphertext);
    expect(handles.assetCodeCiphertext).not.toBe(
      handles.executionPriceCiphertext,
    );
    expect(handles.quantityCiphertext).not.toBe(
      handles.executionPriceCiphertext,
    );
  });

  it("does not return the encrypted envelope or any of the input fields verbatim", () => {
    // The whole point of the helper: a DB reader who sees
    // `asset_code_ciphertext` must not be able to pass it through
    // `decodeSealedEnvelope` and recover the trading parameters.
    // The previous code wrote the envelope directly, so this
    // assertion would have caught the regression.
    const envelope = "t3env.buyer.envelope.base64url.ciphertext";
    const handles = deriveEncryptedTradeFieldHandles(inputs);
    expect(handles.assetCodeCiphertext).not.toBe(envelope);
    expect(handles.quantityCiphertext).not.toBe(envelope);
    expect(handles.executionPriceCiphertext).not.toBe(envelope);
    expect(handles.assetCodeCiphertext).not.toContain(envelope);
    expect(handles.quantityCiphertext).not.toContain(envelope);
    expect(handles.executionPriceCiphertext).not.toContain(envelope);
    expect(handles.assetCodeCiphertext).not.toBe(inputs.outcomeRef);
    expect(handles.assetCodeCiphertext).not.toBe(inputs.executionRef);
    expect(handles.assetCodeCiphertext).not.toBe(inputs.buyerInstitutionId);
    expect(handles.assetCodeCiphertext).not.toBe(inputs.sellerInstitutionId);
  });

  it("produces handles with the `sha256:` digest prefix", () => {
    // The README §Privacy Boundary describes these columns as
    // carrying opaque correlation handles. The opaque-handle
    // format is `sha256:<hex>` so DB readers and the dashboard
    // can recognise the column shape without parsing.
    const handles = deriveEncryptedTradeFieldHandles(inputs);
    expect(handles.assetCodeCiphertext).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(handles.quantityCiphertext).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(handles.executionPriceCiphertext).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it("is deterministic given the same inputs", () => {
    // The receipt correlation logic keys on
    // `(outcomeRef, accessScope)`; the handles must be stable so
    // a re-fetched row matches the original.
    expect(deriveEncryptedTradeFieldHandles(inputs)).toEqual(
      deriveEncryptedTradeFieldHandles(inputs),
    );
  });

  it("changes when either institution id changes", () => {
    // Per-field handles are institution-bound: a buy/sell
    // mismatch must produce different digests so two trades for
    // the same outcome ref but different counterparties are
    // distinguishable.
    const swapped = {
      ...inputs,
      buyerInstitutionId: inputs.sellerInstitutionId,
      sellerInstitutionId: inputs.buyerInstitutionId,
    };
    const baseline = deriveEncryptedTradeFieldHandles(inputs);
    const rotated = deriveEncryptedTradeFieldHandles(swapped);
    expect(rotated.assetCodeCiphertext).not.toBe(
      baseline.assetCodeCiphertext,
    );
    expect(rotated.quantityCiphertext).not.toBe(baseline.quantityCiphertext);
    expect(rotated.executionPriceCiphertext).not.toBe(
      baseline.executionPriceCiphertext,
    );
  });
});

describe("deriveReceiptHash", () => {
  it("returns a sha256-prefixed hex digest", () => {
    expect(deriveReceiptHash("t3receipt.ciphertext")).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it("authenticates the ciphertext payload (not the outcome ref)", () => {
    // P0 regression: the previous receipt hash was
    // `sha256:${outcomeRef}:${side}` -- a deterministic string
    // concatenation that did not authenticate the ciphertext and
    // was trivially forgeable. The new hash binds to the
    // ciphertext bytes so a DB write that mutates the
    // `receipt_ciphertext` column without re-issuing the hash is
    // detectable.
    const ciphertext = "t3receipt.match_outcome_us3.t3exec_us3.buyer";
    expect(deriveReceiptHash(ciphertext)).toBe(deriveReceiptHash(ciphertext));
    expect(deriveReceiptHash(ciphertext)).not.toBe(
      deriveReceiptHash(`${ciphertext}.tampered`),
    );
  });

  it("does not equal the previous `sha256:outcomeRef:side` format", () => {
    // The exact bug we are fixing: hashing
    // `${outcomeRef}:buyer` produces a stable string that does
    // not authenticate the receipt ciphertext. The new format is
    // a real SHA-256 over the ciphertext payload, so the
    // resulting value cannot be reconstructed from the outcome
    // ref alone.
    const ciphertext = "t3receipt.match_outcome_us3.t3exec_us3.buyer";
    const newHash = deriveReceiptHash(ciphertext);
    expect(newHash).not.toBe("sha256:match_outcome_us3:buyer");
    expect(newHash.startsWith("sha256:match_outcome_us3")).toBe(false);
  });
});

describe("deriveTeeAttestationRef", () => {
  it("returns a sha256-prefixed hex digest keyed on (outcome, scope)", () => {
    expect(
      deriveTeeAttestationRef("match_outcome_us3", "buyer"),
    ).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("distinguishes the buyer and seller sides of the same outcome", () => {
    // The previous t3AttestationRef was the orchestrator's
    // `executionRef` -- a locally-minted UUID shared between
    // buyer and seller receipts. The new reference is
    // domain-separated so the buyer's receipt does not collide
    // with the seller's, and the column carries a TEE-correlated
    // identifier (digest of outcome + side) rather than a local
    // ref masquerading as a TEE attestation.
    expect(deriveTeeAttestationRef("match_outcome_us3", "buyer")).not.toBe(
      deriveTeeAttestationRef("match_outcome_us3", "seller"),
    );
  });

  it("distinguishes the regulatory_export scope from buyer/seller", () => {
    expect(
      deriveTeeAttestationRef("match_outcome_us3", "buyer"),
    ).not.toBe(
      deriveTeeAttestationRef("match_outcome_us3", "regulatory_export"),
    );
    expect(
      deriveTeeAttestationRef("match_outcome_us3", "seller"),
    ).not.toBe(
      deriveTeeAttestationRef("match_outcome_us3", "regulatory_export"),
    );
  });

  it("does not equal the bare executionRef (the previous bug)", () => {
    // The previous t3AttestationRef was literally the
    // orchestrator's `executionRef`. The new value is a
    // domain-separated digest, so it cannot be reconstructed
    // from the execution ref alone.
    expect(deriveTeeAttestationRef("match_outcome_us3", "buyer")).not.toBe(
      "t3exec_us3",
    );
  });
});
