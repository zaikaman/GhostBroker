import { describe, expect, it } from "vitest";
import {
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
describe("v0.13.0 settlement ciphertexts", () => {
  it("does not export deriveEncryptedTradeFieldHandles (removed in v0.11.0)", async () => {
    // The function was removed because the SHA-256 digests it
    // produced were re-derivable from the row own columns -
    // zero confidentiality. The TEE now mints real AES-256-GCM
    // ciphertexts via encrypt_trade_field inside evaluate-match /
    // evaluate-round, and the orchestrator writes them directly
    // from the TEE outcome.
    const mod = await import("../privacy/encrypted-trade-fields.js");
    expect((mod as Record<string, unknown>).deriveEncryptedTradeFieldHandles).toBeUndefined();
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
