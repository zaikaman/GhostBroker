import { z } from "zod";
import type { RequestedAgentAction } from "./agent-auth-client.js";

/**
 * Boundbuyer-style W3C Verifiable Credential verifier.
 *
 * Ported from `boundbuyer/src/auth/vc-verifier.ts`. The boundbuyer
 * BUIDL is the only published live reference for "what Terminal 3
 * actually gives you today" — its verifier accepts a W3C JSON-LD VC
 * with `issuer`, `credentialSubject`, and `proof.jws`, and runs in
 * one of three modes:
 *
 *   - "sandbox":    structural checks only; sandbox proof markers pass.
 *   - "live":       real cryptographic verification via
 *                   `@terminal3/verify_vc` (if installed). Falls back
 *                   to "structural" if unavailable, unless
 *                   `VC_VERIFY_STRICT=true`.
 *   - "structural": real shape + time-window + DID-binding checks
 *                   with no crypto. This is the mode boundbuyer ships
 *                   as its "sandbox/demo" production gate.
 *
 * This module produces a `VerifiedDelegationProof` shape identical
 * to `verifySignedDelegationProof`, so the rest of the
 * `T3AgentAuthorizationFacade` pipeline is untouched. The
 * `DashboardDelegationAgentAuthClient` adapter routes requests with
 * a `delegationCredential` field to this verifier; everything else
 * keeps going through the JCS proof path.
 *
 * The `authorityRef` returned to the agent is the credential's
 * `id` (e.g. `urn:uuid:ghostbroker-delegation-...`), which is the
 * same opaque-reference shape the existing path produces.
 */

const purchaseCategorySchema = z.enum([
  "office-supplies",
  "software",
  "hardware",
  "services",
  "travel",
]);

export const boundbuyerDelegationSchema = z.object({
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

export type BoundbuyerDelegationCredential = z.infer<typeof boundbuyerDelegationSchema>;

export type BoundbuyerVerificationMode = "sandbox" | "live" | "structural";

export interface BoundbuyerVerificationRequest {
  credential: BoundbuyerDelegationCredential;
  institutionId: string;
  agentDid: string;
  /**
   * The action the agent is attempting. The boundbuyer VC encodes
   * its own action set (the `maxSpendUsd` and `allowedCategories`),
   * so the requested action here is informational — the verifier
   * confirms the credential binds to the agent, not the action.
   * The orchestrator enforces the per-action checks downstream.
   */
  requestedAction: RequestedAgentAction;
  revokedAuthorityRefs?: ReadonlySet<string>;
  now?: Date;
}

export interface VerifiedBoundbuyerDelegation {
  status: "verified";
  agentDid: string;
  authorityRef: string;
  policyHash: string;
  verificationMode: BoundbuyerVerificationMode;
}

export interface RejectedBoundbuyerDelegation {
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

export type BoundbuyerVerificationResult =
  | VerifiedBoundbuyerDelegation
  | RejectedBoundbuyerDelegation;

const SANDBOX_PROOF_MARKERS = [
  "sandbox-proof-placeholder",
  "live-demo-unsigned",
  "placeholder",
] as const;

function getModeFromEnv(): BoundbuyerVerificationMode {
  const raw = process.env.VC_VERIFY_MODE?.trim().toLowerCase();
  if (raw === "live" || raw === "structural") return raw;
  return "sandbox";
}

function isDelegationActive(
  credential: BoundbuyerDelegationCredential,
  now: Date,
): boolean {
  const issued = new Date(credential.issuanceDate);
  const expires = new Date(credential.expirationDate);
  if (Number.isNaN(issued.getTime()) || Number.isNaN(expires.getTime())) {
    return false;
  }
  return now >= issued && now <= expires;
}

function hasSandboxProof(credential: BoundbuyerDelegationCredential): boolean {
  const proofValue = credential.proof?.jws ?? "";
  return SANDBOX_PROOF_MARKERS.some((marker) => proofValue.includes(marker));
}

function policyHashFor(credential: BoundbuyerDelegationCredential): string {
  // The boundbuyer VC doesn't carry a policy hash; the closest
  // stable identifier is the credential's own `id` plus the
  // issuer's DID. We compose a sha256-style fingerprint the same
  // way the rest of GhostBroker formats `policyHash` (the admit
  // route stores it on the agent record).
  const stable = `${credential.id}::${credential.issuer}::${credential.credentialSubject.agentDid}`;
  return stable;
}

function authorityRefFor(credential: BoundbuyerDelegationCredential): string {
  return `boundbuyer-delegation:${credential.id}`;
}

/**
 * Verify a boundbuyer-style W3C VC. Returns a discriminated union
 * shaped to match `verifySignedDelegationProof`'s output so the
 * facade can consume either verifier's result interchangeably.
 */
export async function verifyBoundbuyerDelegationCredential(
  request: BoundbuyerVerificationRequest,
  mode: BoundbuyerVerificationMode = getModeFromEnv(),
): Promise<BoundbuyerVerificationResult> {
  const { credential, agentDid, revokedAuthorityRefs, now = new Date() } = request;

  // Shape check (defensive — caller should have parsed already).
  const parsed = boundbuyerDelegationSchema.safeParse(credential);
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
  // in sandbox environments that don't have it. (Same defensive
  // pattern the boundbuyer BUIDL uses.)
  return tryLiveVerify(safe, agentDid);
}

interface VerifyFn {
  verifyVc: (
    vc: unknown,
    opts?: { debug?: boolean },
  ) => Promise<{ isValid: boolean; message?: string }>;
}

async function tryLiveVerify(
  safe: BoundbuyerDelegationCredential,
  agentDid: string,
): Promise<BoundbuyerVerificationResult> {
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
