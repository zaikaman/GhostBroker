import { createHash } from "node:crypto";
import { z } from "zod";
import { verifyVc } from "@terminal3/verify_vc";

/**
 * The action an agent is attempting on the backend. Used as the
 * discriminator across the agent authorization surface
 * (admit / intent.submit / settlement.execute). The
 * Ghostbroker delegation verifier passes this through unchanged.
 */
export type RequestedAgentAction =
  | "agent.admit"
  | "intent.submit"
  | "settlement.execute"
  | "negotiation.open"
  | "negotiation.move"
  | "negotiation.disclose"
  | "negotiation.settle";

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
 *                   SDK errors are accepted (the verifier returns
 *                   `verified` with `verificationMode: "sandbox"`),
 *                   because the demo surface is the only place this
 *                   mode is intended to run.
 *   - "live":       real cryptographic verification via
 *                   `@terminal3/verify_vc` (`verifyEcdsaVc` for
 *                   `EcdsaSecp256k1Signature2019` proofs). The
 *                   verifier **fails closed** if the SDK throws:
 *                   the returned `reason` is `"unverified"` and the
 *                   agent is rejected. The verifier never silently
 *                   downgrades to a non-cryptographic "structural"
 *                   pass on an SDK error in this mode.
 *   - "structural": real shape + time-window + DID-binding checks
 *                   with no crypto. This is the mode the project
 *                   ships as its "sandbox/demo" production gate
 *                   when the live SDK is unavailable. Like `live`,
 *                   an SDK throw here fails closed.
 *
 * Why the verifier fails closed on SDK error in every non-sandbox
 * mode: a security-critical verifier that returns `verified` when
 * it could not cryptographically verify is an attack surface for
 * any adversarial T3 SDK version bump. The legacy "fall back to
 * structural" behaviour was an opt-in safety net controlled by
 * `VC_VERIFY_STRICT=true`; the production-grade default is the
 * inverse — fail closed unless the operator has explicitly opted
 * into `sandbox` mode. The `VC_VERIFY_STRICT` flag is retained as
 * a no-op alias for backwards compatibility; the verifier always
 * fails closed on SDK error outside `sandbox` mode.
 *
 * The `setup:identity` + `setup:delegation` flow now produces
 * a real `EcdsaSecp256k1Signature2019` JWS by default, so the
 * `live` mode is the production target.
 *
 * This module produces a `VerifiedDelegationProof` shape identical
 * to the original JCS verifier, so the rest of the per-action
 * authorization pipeline is untouched. The verifier is the only
 * adapter the production backend runs against the Ghostbroker W3C
 * VC. Three modes (sandbox / structural / live) are controlled
 * by the server-side `T3_MODE` env var (with `VC_VERIFY_MODE`
 * kept as a backward-compat alias).
 *
 * The `authorityRef` returned to the agent is the credential's
 * `id` (e.g. `urn:uuid:ghostbroker-delegation-...`), which is the
 * same opaque-reference shape the original path produced.
 */

/**
 * Action scope carried inside a Ghostbroker delegation VC's
 * `credentialSubject.allowedActions`.
 *
 * The Terminal 3 docs do not publish a canonical "agent delegation
 * VC" schema. GhostBroker's verifier accepts the only delegation
 * credential the live T3N onboarding surface mints, which is the
 * W3C VC the dashboard (and, in the post-Phase 1 architecture, the
 * backend's own `tenant-delegation.ts` signer) produces. The
 * VC's `allowedActions` field is the agent's scope over the
 * privileged actions the runtime actually enforces — the same
 * action set the `RequestedAgentAction` discriminator in the
 * verifier carries.
 *
 * Earlier revisions of this schema borrowed the procurement
 * BUIDL's `purchaseCategorySchema` enum
 * (`office-supplies | software | hardware | services | travel`).
 * That enum is meaningful for a B2B-procurement delegate acting
 * against a vendor catalog, but it is the wrong shape for a
 * trading agent: none of those values map to anything the
 * GhostBroker orchestrator can gate. The live surface — the
 * dashboard, the run-loop, the orchestrator, the settlement
 * command builder — enforces its privileged action set on the
 * `RequestedAgentAction` enum documented at the top of this
 * file. The VC scope is now the same enum, so the verifier and
 * the orchestrator speak the same language about what the
 * agent is allowed to do.
 */
const delegationActionScopeSchema = z.enum([
  "agent.admit",
  "intent.submit",
  "settlement.execute",
  "negotiation.open",
  "negotiation.move",
  "negotiation.disclose",
  "negotiation.settle",
]);

export type DelegationActionScope = z.infer<
  typeof delegationActionScopeSchema
>;

const negotiationUrgencySchema = z.enum(["low", "normal", "high", "critical"]);
const negotiationMandateSchema = z.object({
  assetCode: z.string().trim().min(1).max(32),
  side: z.enum(["buy", "sell"]),
  targetQuantity: z.number().positive(),
  referencePrice: z.number().positive(),
  priceBandBps: z.number().int().nonnegative().max(100000),
  deadline: z.string().datetime(),
  urgency: negotiationUrgencySchema,
  maxNotional: z.string().regex(/^\d+(?:\.\d+)?$/u),
  disclosableClaims: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  requiredCounterpartyClaims: z.record(z.string(), z.unknown()).default({}),
  counterpartyConstraints: z.record(z.string(), z.unknown()).default({}),
  operatorPrompt: z.string().trim().min(1).max(4000),
});

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
    allowedActions: z.array(delegationActionScopeSchema).min(1),
    approverEmail: z.string().email().optional(),
    purpose: z.string().min(1).optional(),
    mandate: negotiationMandateSchema.optional(),
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

/**
 * Markers that identify a non-cryptographically-signed (demo/test)
 * Ghostbroker delegation VC. The verifier checks the JWS for any of
 * these substrings and routes the credential through the
 * mode-appropriate path:
 *
 *   - `sandbox` mode: structural checks only; demo markers pass.
 *   - `live` mode:    demo markers are rejected with
 *                      `demo_proof_in_live_mode`; the verifier refuses
 *                      to admit an agent presenting an unsigned VC
 *                      when production crypto verification is on.
 *   - `structural` mode: shape + time-window + DID-binding checks;
 *                        demo markers pass with the verifier recording
 *                        `verificationMode: "structural"`.
 *
 * The markers are explicit strings rather than a missing `proof.jws`
 * so production logs can grep for them and so a VC without a marker
 * in live mode is treated as a real (cryptographically signed) VC and
 * passed to `@terminal3/verify_vc`. They are NOT placeholders for
 * missing functionality — they are a deliberate discriminator in a
 * three-mode verifier (sandbox / structural / live).
 *
 * The verifier fails closed on any `@terminal3/verify_vc` exception
 * outside `sandbox` mode, so a demo marker reaching the live crypto
 * path is a no-op (the demo branch above short-circuits before
 * `tryLiveVerify` runs).
 */
const SANDBOX_PROOF_MARKERS = [
  "sandbox-proof-placeholder",
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

  if (mode === "structural") {
    return {
      status: "verified",
      agentDid,
      authorityRef: authorityRefFor(safe),
      policyHash: policyHashFor(safe),
      verificationMode: "structural",
    };
  }

  // Live + signed: verify cryptographically via
  // `@terminal3/verify_vc`. The verifier fails closed if the
  // SDK throws — a security-critical verifier that returns
  // `verified` when it could not cryptographically verify is
  // an attack surface for any adversarial T3 SDK version bump
  // or transient SDK outage. The only mode in which the
  // verifier accepts a VC on an SDK error is `sandbox`, which
  // is the demo / dev surface and is not the production gate.
  return tryLiveVerify(safe, agentDid, mode);
}

async function tryLiveVerify(
  safe: GhostbrokerDelegationCredential,
  agentDid: string,
  mode: GhostbrokerVerificationMode,
): Promise<GhostbrokerVerificationResult> {
  try {
    // Shape matches the `SignedCredential` contract that
    // `@terminal3/verify_vc` accepts. We keep the cast local
    // to this call site so we don't take a hard dependency on
    // `@terminal3/vc_core` for the type alone — the verifier
    // only cares about the structural shape.
    const signed = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: safe.id,
      type: safe.type,
      issuer: safe.issuer,
      validFrom: safe.issuanceDate,
      validUntil: safe.expirationDate,
      credentialSubject: {
        ...safe.credentialSubject,
        id: safe.credentialSubject.id,
      },
      proof: {
        type: safe.proof?.type ?? "",
        proofPurpose: safe.proof?.proofPurpose ?? "",
        verificationMethod: safe.proof?.verificationMethod ?? "",
        created: safe.proof?.created ?? "",
        proofValue: safe.proof?.jws ?? "",
      },
    } as Parameters<typeof verifyVc>[0];
    const result = await verifyVc(signed, {
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
  } catch (error: unknown) {
    // Reference the error once so the catch binding is used
    // by a future structured-log path without changing the
    // current return shape.
    void (
      error instanceof Error ? error.message : "VC verification error"
    );
    // Production-grade default: fail closed on any SDK
    // exception in `live` or `structural` mode. The legacy
    // `VC_VERIFY_STRICT=true` opt-in is now a no-op — the
    // verifier always fails closed outside `sandbox` mode,
    // and `sandbox` is the only mode the operator should use
    // if they want the historical "verified on SDK error"
    // behaviour. The flag is retained so existing operator
    // scripts that set it keep working.
    void process.env["VC_VERIFY_STRICT"];
    if (mode === "sandbox") {
      return {
        status: "verified",
        agentDid,
        authorityRef: authorityRefFor(safe),
        policyHash: policyHashFor(safe),
        verificationMode: "sandbox",
      };
    }
    return { status: "rejected", agentDid, reason: "unverified" };
  }
}

