import { createHash } from "node:crypto";
import { signEcdsaVcBody, type SignedEcdsaVcProof } from "../../sdk/agent-client/delegation-signer.js";

/**
 * Build a real W3C Verifiable Credential for a counterparty
 * claim the agent wants to put on the table during a
 * negotiation round.
 *
 * The VC is signed with the agent's own secp256k1 keypair (the
 * one `setup:identity` produces) so the backend's
 * `T3NegotiationDisclosureVerifier` can hand it to
 * `@terminal3/verify_vc`'s `verifyVc` and confirm the JWS. The
 * verifier's `t3_attestation_ref` derivation is bound to the
 * `proof.jws` the SDK actually recovered a signer from, so
 * every recorded attestation reference is anchored to real
 * cryptographic evidence — not to a `Date.now() + randomUUID()`
 * synthesis.
 *
 * The previous self-attested shape (`proof.type =
 * "GhostBrokerSelfAttestation2024"` with no JWS) was the
 * P0 disclosure-verifier bug: the verifier returned a
 * `t3_attestation_ref` that was a local hash with no TEE
 * anchor. The new shape is the production target the
 * disclosure-verifier's docstring named.
 *
 * The signing wire format (canonical-JSON byte layout,
 * keccak256 digest, EIP-191 over the hex string, 65-byte
 * `r || s || v` JWS with `v = 27 + recid`) is the same one
 * the delegation VC signer uses, so the SDK's
 * `verifyEcdsaVcSig` accepts this VC with no special-casing.
 */
export interface SignedClaimCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: {
    id: string;
    [claimType: string]: unknown;
  };
  proof: SignedEcdsaVcProof;
}

export interface BuildSignedClaimCredentialInput {
  /**
   * Issuer DID — embedded as `issuer` AND as the signer's DID
   * in `proof.verificationMethod`. The agent self-issues the
   * claim VC (the institution is the trust root, not the
   * agent); a future change can plug an institution-issued
   * claim into the same wire format without altering the
   * verifier.
   */
  issuerDid: string;
  /** Signer's 0x-prefixed 32-byte secp256k1 private key (66 chars). */
  privateKey: string;
  /** Signer's 0x-prefixed 33-byte compressed secp256k1 public key (68 chars). */
  publicKey: string;
  /** The credential subject — typically the institution display name. */
  subjectId: string;
  /** The claim type being attested (e.g. `accredited_institution`). */
  claimType: string;
  /** Assertion value (free-form: string, number, boolean, or object). */
  assertion?: string | Record<string, unknown>;
  /**
   * Optional explicit credential ID. Defaults to a stable
   * `urn:uuid:ghostbroker-claim-<ms>` so retries on the same
   * round yield the same VC id and the verifier's
   * attestation-ref derivation stays deterministic.
   */
  id?: string;
  /** Optional ISO-8601 issuance timestamp. Defaults to `now`. */
  issuedAt?: string;
  /**
   * Optional ISO-8601 expiration timestamp. Defaults to
   * `issuedAt + 1 hour` — short-lived claim credentials
   * match the short-lived nature of a single negotiation
   * round and limit the blast radius of a leaked JWS.
   */
  expiresAt?: string;
  /**
   * Optional EIP-55-checksummed `did:ethr:0x<addr>#controller`
   * reference for the signer. Mirrors the delegation-signer
   * `additionalSignerVerificationMethod` field so an agent
   * whose keypair-derived address differs from its DID's
   * embedded address can still produce a verifier-acceptable
   * VC. Defaults to undefined.
   */
  additionalSignerVerificationMethod?: string;
}

export function buildSignedClaimCredential(
  input: BuildSignedClaimCredentialInput,
): SignedClaimCredential {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const expiresAt =
    input.expiresAt ??
    new Date(new Date(issuedAt).getTime() + 60 * 60 * 1000).toISOString();

  const assertionDigestInput =
    typeof input.assertion === "object" && input.assertion !== null
      ? JSON.stringify(input.assertion)
      : (input.assertion ??
        `self-attested:${input.issuerDid}:${input.claimType}:${issuedAt}`);

  const assertionPayload = {
    attestedBy: input.issuerDid,
    attestedAt: issuedAt,
    digest: createHash("sha256")
      .update(
        `${input.issuerDid}|${input.subjectId}|${input.claimType}|${assertionDigestInput}`,
      )
      .digest("hex"),
    value: assertionDigestInput,
  };

  // The signing body uses the W3C VC v1.1 field names
  // (`validFrom` / `validUntil`). The credential JSON we
  // return to the agent process uses the legacy Ghostbroker
  // `issuanceDate` / `expirationDate` names so the
  // existing disclosure-verifier `toSignedCredential`
  // normalization (which renames them back) is a no-op pass-
  // through.
  const signingBody = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id:
      input.id ?? `urn:uuid:ghostbroker-claim-${new Date(issuedAt).getTime()}`,
    type: ["VerifiableCredential", "GhostBrokerClaimCredential"],
    issuer: input.issuerDid,
    validFrom: issuedAt,
    validUntil: expiresAt,
    credentialSubject: {
      id: input.subjectId,
      [input.claimType]: assertionPayload,
    },
  };

  const proof = signEcdsaVcBody({
    body: signingBody,
    issuerDid: input.issuerDid,
    signerPrivateKey: input.privateKey,
    signerPublicKey: input.publicKey,
    created: issuedAt,
    ...(input.additionalSignerVerificationMethod
      ? {
          additionalSignerVerificationMethod:
            input.additionalSignerVerificationMethod,
        }
      : {}),
  });

  return {
    "@context": [...(signingBody["@context"] as string[])],
    id: signingBody.id,
    type: [...signingBody.type],
    issuer: input.issuerDid,
    issuanceDate: issuedAt,
    expirationDate: expiresAt,
    credentialSubject: {
      ...(signingBody.credentialSubject as {
        id: string;
        [claimType: string]: unknown;
      }),
    },
    proof,
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
