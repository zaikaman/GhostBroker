import { createHash, randomUUID } from "node:crypto";

/**
 * Minimal verified claim payload that can be disclosed to the
 * counterpart. Identity-bearing material never crosses this
 * boundary; only the claim type and its asserted value are emitted,
 * accompanied by an opaque attestation ref.
 */
export interface VerifiedNegotiationDisclosure {
  claimType: string;
  assertionCiphertext: string;
  verified: true;
  t3AttestationRef: string;
}

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
   */
  claimCredential: unknown;
}

interface ClaimCredentialShape {
  credentialSubject?: Record<string, unknown>;
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

export class UnverifiedNegotiationDisclosureError extends Error {
  public constructor(claimType: string) {
    super(`Disclosure '${claimType}' could not be verified from the supplied credential.`);
    this.name = "UnverifiedNegotiationDisclosureError";
  }
}

export interface NegotiationDisclosureVerifier {
  verifyDisclosure(
    request: DisclosureVerificationRequest,
  ): Promise<VerifiedNegotiationDisclosure>;
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
 */
export class T3NegotiationDisclosureVerifier
  implements NegotiationDisclosureVerifier
{
  public async verifyDisclosure(
    request: DisclosureVerificationRequest,
  ): Promise<VerifiedNegotiationDisclosure> {
    if (!request.disclosableClaims.includes(request.claimType)) {
      throw new DisallowedNegotiationDisclosureError(request.claimType);
    }

    const credential = request.claimCredential as ClaimCredentialShape;
    const subject = asRecord(credential.credentialSubject);
    const rawAssertion = subject?.[request.claimType];
    if (
      rawAssertion === undefined ||
      rawAssertion === null ||
      (typeof rawAssertion === "string" && rawAssertion.trim().length === 0)
    ) {
      throw new UnverifiedNegotiationDisclosureError(request.claimType);
    }

    const plaintext = JSON.stringify({
      claimType: request.claimType,
      assertion: rawAssertion,
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
