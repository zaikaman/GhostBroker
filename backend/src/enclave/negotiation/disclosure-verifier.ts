import { createHash } from "node:crypto";
import { verifyVc } from "@terminal3/verify_vc";
import type { SignedCredential } from "@terminal3/vc_core";
import { logger } from "../../logging/logger.js";

/**
 * The outcome of a disclosure verification request.
 *
 * `verified` is true only when `@terminal3/verify_vc`'s `verifyVc`
 * confirms the presented credential's `EcdsaSecp256k1Signature2019`
 * JWS AND the credential's `credentialSubject` actually asserts
 * the claim type being revealed. When the agent submits no
 * credential, an empty/malformed credential, a credential whose
 * `credentialSubject` does not assert the requested claim type,
 * or a credential whose JWS fails SDK verification, the verifier
 * returns `verified: false` (carrying an opaque `t3AttestationRef`
 * for traceability) instead of throwing. The orchestrator records
 * the disclosure either way; the trust-level computation only
 * counts disclosures where `verified === true`. This keeps the
 * agent loop running when a hosted agent reveals without a real
 * W3C VC, while preserving the disclosure-gate guarantee for the
 * eventual settle.
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
   * W3C Verifiable Credential the agent claims to hold. The verifier
   * requires a structurally-valid VC whose `credentialSubject`
   * includes the claim type being revealed AND whose `proof.jws`
   * (or `proof.proofValue`) is an
   * `EcdsaSecp256k1Signature2019` 65-byte signature that
   * `@terminal3/verify_vc`'s `verifyVc` accepts.
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
 * Domain-separation prefix for the disclosure attestation reference.
 * Distinct from `deriveTeeAttestationRef`'s
 * `"ghostbroker.completed_trades.t3_attestation.v1"` so the same
 * (issuer, claimType, JWS, policyHash) tuple produces a different
 * digest on the negotiation_disclosures row vs the audit_receipts
 * row — the two columns are not meant to cross-correlate and the
 * domain separation makes accidental collisions impossible.
 */
const DISCLOSURE_ATTESTATION_DOMAIN =
  "ghostbroker.negotiation_disclosures.t3_attestation.v1";

function digestFor(domain: string, ...parts: readonly string[]): string {
  const input = parts.join("\x1f");
  return createHash("sha256")
    .update(`${domain}\x1f${input}`)
    .digest("hex");
}

/**
 * Stable, content-bound trace reference for an unverified
 * disclosure attempt. The `t3_attestation_ref` column requires
 * a non-empty value even on a failed verification, so the
 * unverified branch needs a deterministic ref that:
 *   - is bound to the disclosure context (claimType, policyHash,
 *     issuer DID) rather than `Date.now()` + `randomUUID()`, so
 *     a duplicate attempt on the same inputs yields the same ref
 *     and an audit reader can correlate without re-running the
 *     SDK,
 *   - carries a visible failure-mode discriminator
 *     (`missing_assertion` / `missing_proof` / the issuer DID)
 *     so an auditor reading the column can tell whether the
 *     ref corresponds to "no cryptographic evidence exists"
 *     or "cryptographic evidence existed and was rejected"
 *     without re-running the SDK.
 *
 * Format: `t3att_unverified_<discriminator>_<digest[:24]>`.
 */
function deriveUnverifiedDisclosureAttestationRef(input: {
  claimType: string;
  policyHash: string;
  issuerTag: string;
}): string {
  // The discriminator must be a safe substring for the column
  // — letters, digits, underscores, dashes, dots, and colons
  // only. The three production values we emit
  // (`missing_assertion`, `missing_proof`, a `did:...` string)
  // all already satisfy that constraint, but a hostile
  // issuer DID could carry newlines or other chars the
  // audit reader would have trouble grepping. Sanitize to
  // a stable token so the column value stays greppable.
  const discriminator = input.issuerTag.replace(/[^a-zA-Z0-9_.:-]/gu, "_");
  return `t3att_unverified_${discriminator}_${digestFor(
    `${DISCLOSURE_ATTESTATION_DOMAIN}.unverified`,
    input.claimType,
    input.policyHash,
    input.issuerTag,
  ).slice(0, 24)}`;
}

/**
 * Bind the verified attestation ref to the cryptographic evidence
 * the SDK actually checked — the JWS the SDK's `verifyEcdsaVcSig`
 * recovered a signer from, plus the issuer DID the SDK matched
 * that recovered signer against, plus the SDK's own
 * `VerificationResult.message` string. Two parties that re-derive
 * this digest from the same inputs MUST converge on the same
 * attestation ref; that is what makes the column an "attestation
 * reference" rather than a UUID.
 *
 * The `t3att_` prefix (no `unverified_`) is the success marker so
 * the audit trail can be filtered without parsing the digest.
 */
function deriveVerifiedDisclosureAttestationRef(input: {
  claimType: string;
  policyHash: string;
  jws: string;
  issuer: string;
  sdkMessage: string;
}): string {
  return `t3att_${digestFor(
    DISCLOSURE_ATTESTATION_DOMAIN,
    input.claimType,
    input.policyHash,
    input.issuer,
    input.jws,
    input.sdkMessage,
  ).slice(0, 32)}`;
}

/**
 * Stable shape check for a W3C VC the SDK accepts. We don't
 * re-implement the SDK's own shape check; we only need to know
 * whether there is enough information to attempt a verification
 * (so the verifier can distinguish "no credential" from
 * "credential failed verification" in its trace logs) and to
 * extract the JWS / issuer for the attestation-ref derivation.
 */
interface ClaimCredentialShape {
  issuer: string;
  jws: string;
  proofType: string;
}

function extractClaimCredentialShape(
  claimCredential: unknown,
): ClaimCredentialShape | undefined {
  const credential = asRecord(claimCredential);
  if (!credential) return undefined;
  const issuer = typeof credential.issuer === "string" ? credential.issuer : "";
  const proof = asRecord(credential.proof);
  if (!proof) return undefined;
  const jws =
    typeof proof.jws === "string"
      ? proof.jws
      : typeof proof.proofValue === "string"
        ? proof.proofValue
        : "";
  const proofType = typeof proof.type === "string" ? proof.type : "";
  if (!issuer || !jws) return undefined;
  return { issuer, jws, proofType };
}

/**
 * v1 disclosure verifier — T3 SDK-backed.
 *
 * The verifier is the cryptographic authority on a counterparty
 * claim disclosure. The production target the file's earlier
 * docstring named ("a T3-backed claim verifier that checks a
 * real credential and returns an enclave-backed
 * `t3_attestation_ref`") is what this implementation now does:
 *
 *   - enforce the mandate allowlist deterministically,
 *   - confirm the presented credential's `credentialSubject`
 *     actually contains the claim,
 *   - call `@terminal3/verify_vc`'s `verifyVc` on the credential
 *     so the SDK cryptographically checks the
 *     `EcdsaSecp256k1Signature2019` JWS — the SDK is the sole
 *     cryptographic authority (no manual fallback path),
 *   - emit a `t3_attestation_ref` that is a domain-separated
 *     SHA-256 digest over (claimType, policyHash, issuer, JWS,
 *     SDK message) on verified outcomes, or over (claimType,
 *     policyHash, issuerTag) on unverified outcomes — so the
 *     column carries a real, content-bound attestation reference
 *     rather than a `Date.now()` + `randomUUID()` synthesis.
 *
 * Missing / malformed credentials are recorded with `verified: false`
 * rather than thrown, so a hosted agent that reveals without a real
 * W3C VC can recover on its next turn instead of crashing the loop
 * with a 500. The trust-level computation filters unverified claims
 * out so the disclosure gate still holds for settlement.
 *
 * Failure modes (all fail closed with `verified: false`):
 *   - SDK throws any error (e.g. "Unsupported DID method" on a
 *     `did:t3n:` issuer, transient SDK outage, malformed proof) —
 *     treated as cryptographic rejection,
 *   - SDK returns `isValid: false` — the recovered signer did not
 *     match the issuer DID's embedded address,
 *   - credential is present but missing `proof.jws` / `proof.proofValue`
 *     or `issuer` — no cryptographic evidence exists to anchor an
 *     attestation ref to,
 *   - `credentialSubject` does not contain the claim type being
 *     revealed — even a valid VC does not authorize the disclosure.
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

    const rawAssertion = extractAssertion(
      request.claimCredential,
      request.claimType,
    );
    if (!rawAssertion.hasAssertion) {
      return {
        claimType: request.claimType,
        assertionCiphertext: "",
        verified: false,
        t3AttestationRef: deriveUnverifiedDisclosureAttestationRef({
          claimType: request.claimType,
          policyHash: request.policyHash,
          issuerTag: "missing_assertion",
        }),
      };
    }

    const shape = extractClaimCredentialShape(request.claimCredential);
    if (!shape) {
      return {
        claimType: request.claimType,
        assertionCiphertext: "",
        verified: false,
        t3AttestationRef: deriveUnverifiedDisclosureAttestationRef({
          claimType: request.claimType,
          policyHash: request.policyHash,
          issuerTag: "missing_proof",
        }),
      };
    }

    const signed = toSignedCredential(request.claimCredential, shape);
    const sdkResult = await trySdkVerify(signed);
    if (!sdkResult.isValid) {
      return {
        claimType: request.claimType,
        assertionCiphertext: "",
        verified: false,
        t3AttestationRef: deriveUnverifiedDisclosureAttestationRef({
          claimType: request.claimType,
          policyHash: request.policyHash,
          issuerTag: shape.issuer,
        }),
      };
    }

    const plaintext = JSON.stringify({
      claimType: request.claimType,
      assertion: rawAssertion.value,
      policyHash: request.policyHash,
    });
    const assertionCiphertext = Buffer.from(plaintext, "utf8").toString(
      "base64url",
    );

    return {
      claimType: request.claimType,
      assertionCiphertext,
      verified: true,
      t3AttestationRef: deriveVerifiedDisclosureAttestationRef({
        claimType: request.claimType,
        policyHash: request.policyHash,
        jws: shape.jws,
        issuer: shape.issuer,
        sdkMessage: sdkResult.message,
      }),
    };
  }
}

interface SdkVerifyResult {
  isValid: boolean;
  message: string;
}

/**
 * Call `@terminal3/verify_vc`'s `verifyVc` on the normalized
 * credential. The T3 SDK is the SOLE cryptographic authority
 * for the disclosure — there is no manual ECDSA fallback path
 * and no structural mode the verifier could silently downgrade
 * to on a transient SDK error.
 *
 * Returns the SDK's `VerificationResult` (`isValid` + `message`)
 * on success, or `{ isValid: false, message: <error string> }`
 * when the SDK throws. Both unverified branches fail closed
 * with `verified: false`; the orchestrator's trust-level filter
 * excludes both from the disclosure gate. The thrown error's
 * message is preserved (prefixed with `sdk_error:`) so the
 * attestation-ref derivation distinguishes SDK-throws from
 * SDK-rejected (`isValid: false`) in the audit trail.
 */
async function trySdkVerify(signed: SignedCredential): Promise<SdkVerifyResult> {
  try {
    const result = await verifyVc(signed, {
      debug: process.env.VC_VERIFY_DEBUG === "true",
    });
    logger.debug(
      {
        issuer: signed.issuer,
        verificationMethod: signed.proof.verificationMethod,
        sdkResult: result,
      },
      "disclosure-verifier SDK verification outcome",
    );
    return { isValid: result.isValid, message: result.message };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    logger.debug({ err: errMessage }, "disclosure-verifier SDK threw");
    return { isValid: false, message: `sdk_error:${errMessage}` };
  }
}

/**
 * Convert the agent-submitted claim credential into the
 * `SignedCredential` shape that `@terminal3/verify_vc`'s
 * `verifyVc` expects. The conversion mirrors the one in
 * `t3-enclave/src/auth/ghostbroker-delegation.ts` so the SDK's
 * `verifyEcdsaVc` path is the one exercised:
 *
 *   - rename `issuanceDate` / `expirationDate` →
 *     `validFrom` / `validUntil` (the W3C VC v1.1 /
 *     `@terminal3/vc_core` field names),
 *   - rename `proof.jws` → `proof.proofValue` (the field the
 *     SDK hashes),
 *   - pass `issuer` and the rest of the body through unchanged.
 *
 * The SDK's `verifyEcdsaVcSig` recovers the signer address from
 * `ethers.verifyMessage` over the `keccak256(JSON.stringify(body))`
 * hex, so any transformation we apply here would change the
 * digest and silently break the cryptographic check.
 */
function toSignedCredential(
  claimCredential: unknown,
  shape: ClaimCredentialShape,
): SignedCredential {
  const credential = asRecord(claimCredential) ?? {};
  const proof = asRecord(credential.proof) ?? {};
  return {
    "@context": [
      ...(Array.isArray(credential["@context"])
        ? (credential["@context"] as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : []),
      "https://www.w3.org/2018/credentials/v1",
    ],
    id:
      typeof credential.id === "string"
        ? (credential.id as `${string}:${string}`)
        : ("urn:uuid:ghostbroker-disclosure-unknown" as `${string}:${string}`),
    type: Array.isArray(credential.type)
      ? (credential.type as string[]).filter(
          (entry) => typeof entry === "string",
        )
      : ["VerifiableCredential"],
    issuer: shape.issuer as `did:${string}:${string}`,
    ...(typeof credential.validFrom === "string"
      ? { validFrom: credential.validFrom }
      : typeof credential.issuanceDate === "string"
        ? { validFrom: credential.issuanceDate }
        : {}),
    ...(typeof credential.validUntil === "string"
      ? { validUntil: credential.validUntil }
      : typeof credential.expirationDate === "string"
        ? { validUntil: credential.expirationDate }
        : {}),
    credentialSubject:
      (asRecord(credential.credentialSubject) as
        | SignedCredential["credentialSubject"]
        | undefined) ?? ({} as SignedCredential["credentialSubject"]),
    proof: {
      type: shape.proofType || (typeof proof.type === "string" ? proof.type : ""),
      proofPurpose:
        typeof proof.proofPurpose === "string" ? proof.proofPurpose : "",
      verificationMethod:
        typeof proof.verificationMethod === "string"
          ? proof.verificationMethod
          : "",
      created: typeof proof.created === "string" ? proof.created : "",
      proofValue: shape.jws,
    },
  };
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
