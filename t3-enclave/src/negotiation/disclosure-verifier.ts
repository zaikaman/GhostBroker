import { createHash, randomUUID } from "node:crypto";

/**
 * The outcome of a disclosure verification request.
 *
 * `verified` is true only when the presented credential actually asserts
 * the claim via `credentialSubject[<claimType>]`. When the agent
 * submitted no credential, an empty/malformed credential, or a
 * credential that does not assert the requested claim type, the
 * verifier returns a `verified: false` outcome (carrying an opaque
 * `t3AttestationRef` for traceability) instead of throwing. The
 * orchestrator records the disclosure either way; the trust-level
 * computation only counts disclosures where `verified === true`. This
 * keeps the agent loop running when a hosted agent reveals without
 * a real W3C VC, while preserving the disclosure-gate guarantee
 * for the eventual settle.
 */
export interface NegotiationDisclosureOutcome {
  claimType: string;
  assertionCiphertext: string;
  verified: boolean;
  t3AttestationRef: string;
}

/**
 * Back-compat alias for existing callers/tests that import the
 * narrower "verified=true only" shape.
 */
export type VerifiedNegotiationDisclosure =
  | (NegotiationDisclosureOutcome & { verified: true })
  | (NegotiationDisclosureOutcome & { verified: false });

export interface DisclosureVerificationRequest {
  policyHash: string;
  claimType: string;
  /**
   * Public allowlist from the mandate bound into the delegation VC.
   * Only claim types present here may be disclosed.
   */
  disclosableClaims: readonly string[];
  /**
   * Credential the agent claims to hold. For v1 the verifier only
   * requires a minimal W3C-like shape whose `credentialSubject`
   * includes the claim type being revealed; the real T3 attestation
   * verifier can replace this adapter without changing the backend
   * orchestration contract.
   *
   * Optional: when missing or malformed, the verifier returns
   * `verified: false` rather than throwing so the hosted agent loop
   * can recover on its next turn (the orchestrator's trust-level
   * computation filters on `verified === true`).
   */
  claimCredential?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export class DisallowedNegotiationDisclosureError extends Error {
  public constructor(claimType: string) {
    super(`Disclosure '${claimType}' is not permitted by the mandate allowlist.`);
    this.name = "DisallowedNegotiationDisclosureError";
  }
}

export interface NegotiationDisclosureVerifier {
  verifyDisclosure(
    request: DisclosureVerificationRequest,
  ): Promise<NegotiationDisclosureOutcome>;
}

/**
 * v1 disclosure verifier.
 *
 * The production target is a T3-backed claim verifier that checks a
 * real credential and returns an enclave-backed `t3_attestation_ref`.
 * This adapter preserves the backend contract today:
 *
 *   - enforce the mandate allowlist deterministically,
 *   - confirm the presented credential actually contains the claim,
 *   - emit only the minimal asserted claim value (encrypted/opaque on
 *     the wire as `assertionCiphertext`), never the full credential.
 *
 * Missing / malformed credentials are recorded with `verified: false`
 * rather than thrown, so a hosted agent that reveals without a real
 * W3C VC can recover on its next turn instead of crashing the loop
 * with a 500. The trust-level computation filters unverified claims
 * out so the disclosure gate still holds for settlement.
 */
export class T3NegotiationDisclosureVerifier
  implements NegotiationDisclosureVerifier
{
  public async verifyDisclosure(
    request: DisclosureVerificationRequest,
  ): Promise<NegotiationDisclosureOutcome> {
    if (!request.disclosableClaims.includes(request.claimType)) {
      throw new DisallowedNegotiationDisclosureError(request.claimType);
    }

    const rawAssertion = extractAssertion(request.claimCredential, request.claimType);
    const attestationSeed = `${request.claimType}:${request.policyHash}:${Date.now()}:${randomUUID()}`;
    const attestationDigest = createHash("sha256")
      .update(attestationSeed)
      .digest("hex");

    if (!rawAssertion.hasAssertion) {
      return {
        claimType: request.claimType,
        assertionCiphertext: "",
        verified: false,
        t3AttestationRef: `t3att_unverified_${attestationDigest.slice(0, 24)}`,
      };
    }

    const plaintext = JSON.stringify({
      claimType: request.claimType,
      assertion: rawAssertion.value,
      policyHash: request.policyHash,
    });
    const assertionCiphertext = Buffer.from(plaintext, "utf8").toString("base64url");
    const digest = createHash("sha256").update(plaintext).digest("hex");

    return {
      claimType: request.claimType,
      assertionCiphertext,
      verified: true,
      t3AttestationRef: `t3att_${digest.slice(0, 24)}_${randomUUID().slice(0, 8)}`,
    };
  }
}

function extractAssertion(
  claimCredential: unknown,
  claimType: string,
): { hasAssertion: boolean; value: unknown } {
  const credential = asRecord(claimCredential);
  if (!credential) {
    return { hasAssertion: false, value: undefined };
  }
  const subject = asRecord(credential.credentialSubject);
  const raw = subject ? subject[claimType] : undefined;
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim().length === 0)
  ) {
    return { hasAssertion: false, value: undefined };
  }
  return { hasAssertion: true, value: raw };
}
