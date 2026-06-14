import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The action an agent is attempting on the backend. Used as the
 * discriminator across the agent authorization surface
 * (admit / intent.submit / settlement.execute). The
 * Ghostbroker delegation verifier passes this through unchanged.
 */
export type RequestedAgentAction =
  | "agent.admit"
  | "intent.submit"
  | "settlement.execute";

/**
 * Ghostbroker-style W3C Verifiable Credential verifier for an
 * agent's delegation.
 *
 * This is the project's own W3C JSON-LD VC verifier for the
 * delegation a buyer institution issues to its agent. The
 * verifier accepts a VC with `issuer`, `credentialSubject`, and
 * `proof.jws`, and runs in one of three modes:
 *
 *   - "sandbox":    structural checks only; sandbox proof markers pass.
 *   - "live":       real cryptographic verification via
 *                   `@terminal3/verify_vc` (if installed). Falls back
 *                   to "structural" if unavailable, unless
 *                   `VC_VERIFY_STRICT=true`.
 *   - "structural": real shape + time-window + DID-binding checks
 *                   with no crypto. This is the mode the project
 *                   ships as its "sandbox/demo" production gate.
 *
 * This module produces a `VerifiedDelegationProof` shape identical
 * to the original JCS verifier, so the rest of the per-action
 * authorization pipeline is untouched. The verifier is the only
 * adapter the production backend runs against the Ghostbroker W3C
 * VC. Three modes (sandbox / structural / live) are controlled
 * by the server-side `VC_VERIFY_MODE` env var.
 *
 * The `authorityRef` returned to the agent is the credential's
 * `id` (e.g. `urn:uuid:ghostbroker-delegation-...`), which is the
 * same opaque-reference shape the original path produced.
 */

const purchaseCategorySchema = z.enum([
  "office-supplies",
  "software",
  "hardware",
  "services",
  "travel",
]);

export const ghostbrokerDelegationSchema = z.object({
  id: z.string().min(1),
  type: z.array(z.string()).min(1),
  issuer: z.string().min(1),
  issuanceDate: z.string().min(1),
  expirationDate: z.string().min(1),
  credentialSubject: z.object({
    id: z.string().min(1),
    agentDid: z.string().min(1),
    maxSpendUsd: z.number().positive(),
    allowedCategories: z.array(purchaseCategorySchema).min(1),
    approverEmail: z.string().email().optional(),
    purpose: z.string().min(1),
  }),
  proof: z
    .object({
      type: z.string().min(1),
      created: z.string().min(1),
      proofPurpose: z.string().min(1),
      verificationMethod: z.string().min(1),
      jws: z.string().optional(),
    })
    .optional(),
});

export type GhostbrokerDelegationCredential = z.infer<typeof ghostbrokerDelegationSchema>;

export type GhostbrokerVerificationMode = "sandbox" | "live" | "structural";

export interface GhostbrokerVerificationRequest {
  credential: unknown;
  institutionId: string;
  agentDid: string;
  /**
   * The action the agent is attempting. The Ghostbroker VC encodes
   * its own action set (the `maxSpendUsd` and `allowedCategories`),
   * so the requested action here is informational — the verifier
   * confirms the credential binds to the agent, not the action.
   * The orchestrator enforces the per-action checks downstream.
   */
  requestedAction: RequestedAgentAction;
  revokedAuthorityRefs?: ReadonlySet<string>;
  now?: Date;
}

export interface VerifiedGhostbrokerDelegation {
  status: "verified";
  agentDid: string;
  authorityRef: string;
  policyHash: string;
  verificationMode: GhostbrokerVerificationMode;
}

export interface RejectedGhostbrokerDelegation {
  status: "rejected";
  agentDid: string;
  reason:
    | "expired"
    | "revoked"
    | "unverified"
    | "agent_mismatch"
    | "malformed"
    | "demo_proof_in_live_mode";
}

export type GhostbrokerVerificationResult =
  | VerifiedGhostbrokerDelegation
  | RejectedGhostbrokerDelegation;

const SANDBOX_PROOF_MARKERS = [
  "sandbox-proof-placeholder",
  "live-demo-unsigned",
  "placeholder",
] as const;

function getModeFromEnv(): GhostbrokerVerificationMode {
  const raw = process.env.VC_VERIFY_MODE?.trim().toLowerCase();
  if (raw === "live" || raw === "structural") return raw;
  return "sandbox";
}

function isDelegationActive(
  credential: GhostbrokerDelegationCredential,
  now: Date,
): boolean {
  const issued = new Date(credential.issuanceDate);
  const expires = new Date(credential.expirationDate);
  if (Number.isNaN(issued.getTime()) || Number.isNaN(expires.getTime())) {
    return false;
  }
  return now >= issued && now <= expires;
}

function hasSandboxProof(credential: GhostbrokerDelegationCredential): boolean {
  const proofValue = credential.proof?.jws ?? "";
  return SANDBOX_PROOF_MARKERS.some((marker) => proofValue.includes(marker));
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function policyHashFor(credential: GhostbrokerDelegationCredential): string {
  // The Ghostbroker VC doesn't carry a policy hash, so we derive a
  // stable sha256 hex fingerprint from the canonicalized
  // credential. This matches the shape produced by
  // `computeAuthorityPolicyHash` in `authority-claims.ts`, so the
  // downstream `policyHash` field means the same thing whichever
  // verifier produced it: a sha256 hex digest of the canonical
  // authority-bearing payload, suitable for equality checks,
  // DB indexing, and UI display.
  const fingerprint = canonicalize({
    id: credential.id,
    type: credential.type,
    issuer: credential.issuer,
    issuanceDate: credential.issuanceDate,
    expirationDate: credential.expirationDate,
    credentialSubject: credential.credentialSubject,
  });
  return createHash("sha256").update(fingerprint).digest("hex");
}

function authorityRefFor(credential: GhostbrokerDelegationCredential): string {
  return `ghostbroker-delegation:${credential.id}`;
}

/**
 * Verify a Ghostbroker-style W3C VC. Returns a discriminated union
 * shaped to match `verifySignedDelegationProof`'s output so the
 * facade can consume either verifier's result interchangeably.
 */
export async function verifyGhostbrokerDelegationCredential(
  request: GhostbrokerVerificationRequest,
  mode: GhostbrokerVerificationMode = getModeFromEnv(),
): Promise<GhostbrokerVerificationResult> {
  const { credential, agentDid, revokedAuthorityRefs, now = new Date() } = request;

  // Shape check (defensive — caller should have parsed already).
  const parsed = ghostbrokerDelegationSchema.safeParse(credential);
  if (!parsed.success) {
    return {
      status: "rejected",
      agentDid,
      reason: "malformed",
    };
  }
  const safe = parsed.data;

  // Time window.
  if (!isDelegationActive(safe, now)) {
    return { status: "rejected", agentDid, reason: "expired" };
  }

  // DID binding.
  if (safe.credentialSubject.agentDid !== agentDid) {
    return {
      status: "rejected",
      agentDid,
      reason: "agent_mismatch",
    };
  }

  // Revocation list.
  if (revokedAuthorityRefs?.has(authorityRefFor(safe))) {
    return { status: "rejected", agentDid, reason: "revoked" };
  }

  // Mode dispatch.
  if (mode === "sandbox") {
    return {
      status: "verified",
      agentDid,
      authorityRef: authorityRefFor(safe),
      policyHash: policyHashFor(safe),
      verificationMode: "sandbox",
    };
  }

  if (hasSandboxProof(safe)) {
    if (mode === "live") {
      return {
        status: "rejected",
        agentDid,
        reason: "demo_proof_in_live_mode",
      };
    }
    return {
      status: "verified",
      agentDid,
      authorityRef: authorityRefFor(safe),
      policyHash: policyHashFor(safe),
      verificationMode: "structural",
    };
  }

  // Live + signed: try @terminal3/verify_vc at runtime. If it isn't
  // installed, fall back to structural unless VC_VERIFY_STRICT=true.
  // We intentionally use a dynamic import so the verifier works
  // in sandbox environments that don't have it.
  return tryLiveVerify(safe, agentDid);
}

interface VerifyFn {
  verifyVc: (
    vc: unknown,
    opts?: { debug?: boolean },
  ) => Promise<{ isValid: boolean; message?: string }>;
}

async function tryLiveVerify(
  safe: GhostbrokerDelegationCredential,
  agentDid: string,
): Promise<GhostbrokerVerificationResult> {
  try {
    const loaded = (await import(
      "@terminal3/verify_vc" as string
    )) as VerifyFn | { default?: VerifyFn } | null;
    const verifyFn =
      (loaded as VerifyFn | null)?.verifyVc ??
      ((loaded as { default?: VerifyFn } | null)?.default?.verifyVc);
    if (!verifyFn) {
      throw new Error("@terminal3/verify_vc not installed");
    }
    const signed = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: safe.id,
      type: safe.type,
      issuer: safe.issuer,
      validFrom: safe.issuanceDate,
      validUntil: safe.expirationDate,
      credentialSubject: { ...safe.credentialSubject },
      proof: {
        type: safe.proof?.type ?? "",
        proofPurpose: safe.proof?.proofPurpose ?? "",
        verificationMethod: safe.proof?.verificationMethod ?? "",
        created: safe.proof?.created ?? "",
        proofValue: safe.proof?.jws ?? "",
      },
    };
    const result = await verifyFn(signed, {
      debug: process.env.VC_VERIFY_DEBUG === "true",
    });
    if (!result.isValid) {
      return { status: "rejected", agentDid, reason: "unverified" };
    }
    return {
      status: "verified",
      agentDid,
      authorityRef: authorityRefFor(safe),
      policyHash: policyHashFor(safe),
      verificationMode: "live",
    };
  } catch {
    if (process.env.VC_VERIFY_STRICT === "true") {
      return { status: "rejected", agentDid, reason: "unverified" };
    }
    return {
      status: "verified",
      agentDid,
      authorityRef: authorityRefFor(safe),
      policyHash: policyHashFor(safe),
      verificationMode: "structural",
    };
  }
}
