-- Migration 022: relax the `negotiation_disclosures.claim_assertion_ciphertext`
-- CHECK constraint so unverified disclosures can be persisted as audit rows.
--
-- The orchestrator (`NegotiationOrchestrator.handleDisclosure`) ALWAYS appends
-- a row to `negotiation_disclosures`, regardless of whether the T3 VC
-- verifier accepted the credential. This is the audit trail for failed
-- disclosures: the row's `t3_attestation_ref` carries the failure reason
-- (e.g. `t3att_unverified_missing_assertion_<hash>`,
-- `t3att_unverified_missing_proof_<hash>`, or the issuer DID tag when the
-- SDK rejected the JWS). The disclosure gate only counts rows with
-- `verified = true` toward the per-side required-claims set, so unverified
-- rows do not affect settlement.
--
-- When the verifier returns `verified: false`, there is no signed assertion
-- to embed, so `NegotiationOrchestrator.handleDisclosure` writes an empty
-- string for `claim_assertion_ciphertext`. Migration 015 had an unconditional
-- `CHECK (claim_assertion_ciphertext <> '')` that rejected those rows with
-- SQLSTATE 23514 (`violates check constraint
-- "negotiation_disclosures_claim_assertion_ciphertext_check"`), bubbling up
-- as a 503 `service_unavailable` on `POST /api/negotiations/:id/moves`
-- whenever a `reveal` move reached the verifier without a usable credential.
--
-- This migration replaces that constraint with a conditional one: the
-- ciphertext may be empty only when the row is unverified. Verified rows
-- still MUST carry a real assertion ciphertext — that invariant is the
-- reason the column exists in the first place.

ALTER TABLE public.negotiation_disclosures
  DROP CONSTRAINT IF EXISTS negotiation_disclosures_claim_assertion_ciphertext_check;

ALTER TABLE public.negotiation_disclosures
  ADD CONSTRAINT negotiation_disclosures_claim_assertion_ciphertext_check
  CHECK (
    verified = false
    OR (verified = true AND claim_assertion_ciphertext <> '')
  );

COMMENT ON CONSTRAINT negotiation_disclosures_claim_assertion_ciphertext_check
  ON public.negotiation_disclosures IS
  'Verified disclosures must embed a real assertion ciphertext; unverified audit rows may have an empty ciphertext and rely on t3_attestation_ref to carry the failure reason.';
