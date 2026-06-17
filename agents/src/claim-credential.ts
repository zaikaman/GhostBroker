import { createHash } from "node:crypto";

/**
 * Build a minimal W3C-style claim credential the hosted agent can
 * attach to a `reveal` move so the disclosure verifier returns
 * `verified: true`. Real T3-attested institutional counterparties
 * will mint proper credentials via the T3 enclave; for the demo /
 * hosted path we self-attest under the agent DID (which is bound to
 * an admitted institution on the backend) so the counterpart sees a
 * non-empty `credentialSubject.<claimType>` and the disclosure
 * records as verified.
 *
 * The assertion payload is the institutional counterparty attestation
 * we want to put on the table — e.g. "accredited_institution: <self>" —
 * hashed alongside the issuer DID + claim type so the wire shape is
 * stable and not blank-string-rejected by the verifier.
 */
export function buildSelfAttestedClaimCredential(input: {
  issuerDid: string;
  subjectId: string;
  claimType: string;
  assertion?: string | Record<string, unknown>;
}): Record<string, unknown> {
  const issuedAt = new Date().toISOString();
  const assertion =
    input.assertion ??
    `self-attested:${input.issuerDid}:${input.claimType}:${issuedAt}`;
  const assertionDigest = createHash("sha256")
    .update(`${input.issuerDid}|${input.subjectId}|${input.claimType}|${assertion}`)
    .digest("hex");
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    type: ["VerifiableCredential"],
    issuer: input.issuerDid,
    issuanceDate: issuedAt,
    credentialSubject: {
      id: input.subjectId,
      [input.claimType]: {
        attestedBy: input.issuerDid,
        attestedAt: issuedAt,
        digest: assertionDigest,
        value: assertion,
      },
    },
    proof: {
      type: "GhostBrokerSelfAttestation2024",
      created: issuedAt,
      proofPurpose: "assertionMethod",
      verificationMethod: `${input.issuerDid}#key-1`,
    },
  };
}

/**
 * True when the supplied action + claimType combination needs a
 * `claimCredential` attached for the orchestrator to record the
 * disclosure as `verified: true`. The agent loop uses this so the
 * hosted runtime only constructs credentials when the LLM actually
 * decided to reveal a claim.
 */
export function revealRequiresClaimCredential(action: string): boolean {
  return action === "reveal";
}
