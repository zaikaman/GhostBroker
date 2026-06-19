import type { DelegationCredential } from "./delegation.js";
import { isDelegationActive } from "./delegation.js";

/**
 * Ported from `ghostbroker-delegation/src/auth/vc-verifier.ts`.
 *
 * The verifier runs in exactly one mode — `live` — and
 * performs full `EcdsaSecp256k1Signature2019` cryptographic
 * verification via `@terminal3/verify_vc`. It fails closed on
 * any SDK error or runtime import failure: the agent process
 * must refuse to present a VC it could not cryptographically
 * verify, because the backend's `loadAndVerify` facade runs
 * the same fail-closed verifier on every privileged call and
 * would reject it.
 *
 * The previous three-mode design (`sandbox` / `structural` /
 * `live`) has been collapsed. The `setup:identity` +
 * `setup:delegation` flow produces a real signed JWS by
 * default, so there is no `sandbox` demo surface to opt into,
 * no `structural` shape-only escape hatch, and no
 * `T3_MODE` / `VC_VERIFY_MODE` env var to flip. The
 * `verificationMode` field on the result is retained for
 * backward compatibility with code that branched on
 * `mode === "live"`; it always reports `"live"`.
 */

export interface VerificationResult {
  verified: boolean;
  mode: "live";
  message: string;
  warnings: string[];
}

interface SignedCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: Record<string, unknown>;
  proof: {
    type: string;
    proofPurpose: string;
    verificationMethod: string;
    created: string;
    proofValue: string;
  };
}

function toSignedCredential(vc: DelegationCredential): SignedCredential {
  const proof = vc.proof;
  if (!proof?.jws && !proof?.verificationMethod) {
    throw new Error("Delegation credential is missing proof metadata.");
  }
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: vc.id,
    type: vc.type,
    issuer: vc.issuer,
    validFrom: vc.issuanceDate,
    validUntil: vc.expirationDate,
    credentialSubject: {
      ...vc.credentialSubject,
    },
    proof: {
      type: proof.type,
      proofPurpose: proof.proofPurpose,
      verificationMethod: proof.verificationMethod,
      created: proof.created,
      proofValue: proof.jws ?? "",
    },
  };
}

export async function verifyDelegationCredential(
  vc: DelegationCredential,
  expectedAgentDid?: string,
): Promise<VerificationResult> {
  const warnings: string[] = [];

  if (!isDelegationActive(vc)) {
    return {
      verified: false,
      mode: "live",
      message: "Delegation credential has expired or is not yet valid.",
      warnings,
    };
  }

  if (expectedAgentDid && vc.credentialSubject.agentDid !== expectedAgentDid) {
    return {
      verified: false,
      mode: "live",
      message: `Credential was issued for agent ${vc.credentialSubject.agentDid}, not ${expectedAgentDid}.`,
      warnings,
    };
  }

  // Live + signed: try to load @terminal3/verify_vc at runtime.
  // The verifier fails closed on any SDK error or missing module
  // — a security-critical verifier that returns `verified: true`
  // when it could not cryptographically verify is an attack
  // surface for any adversarial T3 SDK version bump.
  try {
    const verifyVcModule = (await import("@terminal3/verify_vc" as string).catch(
      () => null,
    )) as { verifyVc?: (vc: SignedCredential, opts?: { debug?: boolean }) => Promise<{ isValid: boolean; message?: string }> } | null;
    if (!verifyVcModule?.verifyVc) {
      throw new Error("@terminal3/verify_vc not installed");
    }
    const signed = toSignedCredential(vc);
    const result = await verifyVcModule.verifyVc(signed, {
      debug: process.env.VC_VERIFY_DEBUG === "true",
    });
    if (!result.isValid) {
      return {
        verified: false,
        mode: "live",
        message: result.message || "VC cryptographic verification failed.",
        warnings,
      };
    }
    return {
      verified: true,
      mode: "live",
      message: result.message || "Delegation credential verified.",
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "VC verification error";
    return {
      verified: false,
      mode: "live",
      message: `Cryptographic verification failed: ${message}`,
      warnings,
    };
  }
}
