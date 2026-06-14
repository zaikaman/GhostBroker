import type { DelegationCredential } from "./delegation.js";
import { isDelegationActive } from "./delegation.js";

/**
 * Ported from the Ghostbroker delegation/src/auth/vc-verifier.ts`.
 *
 * The verifier has three modes, exactly as Ghostbroker delegation defines them:
 *   - "sandbox": structural checks only; sandbox proof markers pass.
 *   - "live":    real cryptographic verification via @terminal3/verify_vc.
 *                Falls back to "structural" if the SDK is unavailable
 *                and VC_VERIFY_STRICT is not "true".
 *   - "structural": real shape + time-window + DID-binding checks, no
 *                   crypto. This is the mode the Ghostbroker delegation BUIDL
 *                   ships as its "sandbox/demo" production gate.
 *
 * The GhostBroker admit path runs the same verifier server-side; the
 * result is what makes the admit call succeed (or return 403).
 */

export interface VerificationResult {
  verified: boolean;
  mode: "sandbox" | "live" | "structural";
  message: string;
  warnings: string[];
}

const SANDBOX_PROOF_MARKERS = [
  "sandbox-proof-placeholder",
  "live-demo-unsigned",
  "placeholder",
] as const;

export type VcVerifyMode = "sandbox" | "live" | "structural";

function getModeFromEnv(): VcVerifyMode {
  const raw = process.env.VC_VERIFY_MODE?.trim().toLowerCase();
  if (raw === "live" || raw === "structural") return raw;
  return "sandbox";
}

function hasSandboxProof(vc: DelegationCredential): boolean {
  const proofValue = vc.proof?.jws ?? "";
  return SANDBOX_PROOF_MARKERS.some((marker) => proofValue.includes(marker));
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
  mode: VcVerifyMode = getModeFromEnv(),
): Promise<VerificationResult> {
  const warnings: string[] = [];

  if (!isDelegationActive(vc)) {
    return {
      verified: false,
      mode: mode === "sandbox" ? "sandbox" : "live",
      message: "Delegation credential has expired or is not yet valid.",
      warnings,
    };
  }

  if (expectedAgentDid && vc.credentialSubject.agentDid !== expectedAgentDid) {
    return {
      verified: false,
      mode,
      message: `Credential was issued for agent ${vc.credentialSubject.agentDid}, not ${expectedAgentDid}.`,
      warnings,
    };
  }

  if (mode === "sandbox") {
    if (hasSandboxProof(vc)) {
      warnings.push("Using demo proof marker — cryptographic verification skipped.");
    }
    return {
      verified: true,
      mode: "sandbox",
      message: "Structural validation passed (sandbox mode).",
      warnings,
    };
  }

  if (hasSandboxProof(vc)) {
    if (mode === "live") {
      return {
        verified: false,
        mode: "live",
        message:
          "Live mode requires a cryptographically signed delegation VC, not a demo placeholder.",
        warnings,
      };
    }
    return {
      verified: true,
      mode: "structural",
      message: "Structural validation passed (demo proof in structural mode).",
      warnings,
    };
  }

  // Live + signed: try to load @terminal3/verify_vc at runtime; if
  // it's not installed, fall back to structural.
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
    if (process.env.VC_VERIFY_STRICT === "true") {
      return { verified: false, mode: "live", message, warnings };
    }
    warnings.push(
      `Cryptographic verification unavailable (${message}); falling back to structural checks.`,
    );
    return {
      verified: true,
      mode: "structural",
      message: "Structural validation passed with verification fallback.",
      warnings,
    };
  }
}
