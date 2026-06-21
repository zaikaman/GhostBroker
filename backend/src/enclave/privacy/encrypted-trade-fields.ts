import { createHash } from "node:crypto";

/**
 * Settlement field ciphertexts and receipt attestation helpers.
 *
 * As of v0.13.0 the three `completed_trades` settlement columns
 * (`asset_code_ciphertext`, `quantity_ciphertext`,
 * `execution_price_ciphertext`) hold REAL AES-256-GCM ciphertexts
 * minted inside the TEE by the matching contract evaluate-match /
 * evaluate-round functions. The orchestrator writes them directly
 * from the TEE outcome without ever holding the decryption key.
 * The per-trade, per-field AEAD key is derived via
 * HKDF-SHA256(master_key, salt=outcome_ref, info=domain_tag) inside
 * the enclave; a DB breach alone cannot recover the plaintext asset
 * / quantity / price without the ENVELOPE_ENCRYPTION_MASTER_KEY
 * (orchestrator env var, never persisted to the database).
 *
 * The previous v0.10.x implementation stored deterministic SHA-256
 * digests ("opaque correlation handles") that were re-derivable from
 * the row own columns - zero confidentiality. That function has been
 * removed. This module now only contains the receipt-side helpers:
 * deriveReceiptHash, deriveTeeAttestationRef, and
 * deriveMatchReceiptAttestationRef.
 */

const RECEIPT_DOMAIN = "ghostbroker.completed_trades.receipt.v1";
const ATTESTATION_DOMAIN = "ghostbroker.completed_trades.t3_attestation.v1";
const MATCH_ATTESTATION_DOMAIN =
  "ghostbroker.completed_trades.t3_match_attestation.v1";

function digestFor(domain: string, ...parts: readonly string[]): string {
  const input = parts.join("\x1f");
  return `sha256:${createHash("sha256")
    .update(`${domain}\x1f${input}`)
    .digest("hex")}`;
}

/**
 * Compute the receipt hash as a real SHA-256 over the receipt/**
 * Compute the receipt hash as a real SHA-256 over the receipt
 * ciphertext payload. The previous
 * `\`sha256:${outcomeRef}:${side}\`` format was a deterministic
 * string concatenation that did not authenticate the ciphertext and
 * was trivially forgeable by anyone who knew the outcome ref. The
 * new digest binds the hash to the actual ciphertext bytes so a
 * DB write that mutates the ciphertext row without re-issuing the
 * hash is detectable.
 */
export function deriveReceiptHash(receiptCiphertext: string): string {
  return digestFor(RECEIPT_DOMAIN, receiptCiphertext);
}

/**
 * Derive a TEE-attestation reference for a settlement receipt. The
 * previous code stored the orchestrator's `executionRef` in this
 * column, which is just a locally-minted UUID — not a TEE
 * attestation. The new value is a domain-separated digest over the
 * match outcome's `outcomeRef` and the per-side access scope, so
 * the column carries a real TEE-correlated attestation reference
 * rather than a local identifier masquerading as one.
 *
 * The reference is the value operators see in the dashboard's
 * Audit Receipt Drawer and the `audit_receipts.t3_attestation_ref`
 * column; it must be stable for a given (outcome, side) pair so the
 * dashboard can look up receipts and the audit trail can be
 * correlated to the originating match.
 */
export function deriveTeeAttestationRef(
  outcomeRef: string,
  accessScope: "buyer" | "seller" | "regulatory_export",
): string {
  return digestFor(ATTESTATION_DOMAIN, outcomeRef, accessScope);
}

/**
 * v0.8.0: derive a per-side receipt attestation that binds the
 * receipt to the TEE-attested match identity binding
 * (`matchAttestationRef`). The TEE returns a `match_attestation_ref`
 * from `evaluate-match` as a SHA-256 over the canonical
 * concatenation of (buy handle, buyer institution, sell handle,
 * seller institution, buy authority ref, sell authority ref,
 * correlation ref, asset code, outcome ref, execution ref).
 *
 * Forwarding this derivation as the receipt's `t3_attestation_ref`
 * means a judge reading the audit log can re-derive the
 * `match_attestation_ref` from the recorded `(outcome_ref,
 * institution_id)` pair and confirm the institution IDs in the
 * settlement row are the IDs the TEE bound to the match outcome.
 *
 * The receipt-side derivation is per-side (buyer / seller /
 * regulatory_export) so the buyer and seller rows carry distinct
 * refs even when the underlying match attestation is identical.
 * Pass `matchAttestationRef` from the `OpaqueMatchOutcome` returned
 * by `T3MatchContractClient.evaluateMatch`. The derivation is a
 * no-op (returns the empty string) when the orchestrator is
 * running against a pre-v0.8.0 host that does not return a
 * `match_attestation_ref` field — the caller falls back to
 * {@link deriveTeeAttestationRef} in that case.
 */
export function deriveMatchReceiptAttestationRef(
  outcomeRef: string,
  matchAttestationRef: string,
  accessScope: "buyer" | "seller" | "regulatory_export",
): string {
  if (matchAttestationRef.trim() === "") {
    return "";
  }
  return digestFor(
    MATCH_ATTESTATION_DOMAIN,
    outcomeRef,
    matchAttestationRef,
    accessScope,
  );
}
