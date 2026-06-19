import { createHash } from "node:crypto";
import { z } from "zod";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethers } from "ethers";

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
  /**
   * Additional Ethereum addresses (lowercased, with `0x` prefix)
   * the verifier accepts as a valid signer of the credential,
   * in addition to the address derived from `credential.issuer`.
   *
   * Why this exists: the production signer (`tenant-delegation.ts`)
   * uses the institution's T3 SDK API key as its `privateKey`.
   * The T3 SDK authenticates with that key and the server returns
   * a `did:t3n:0x<addr>` whose embedded address does NOT match
   * the API key's derived address (the SDK WASM does a non-
   * standard derivation). The signature still has to be
   * cryptographically valid — `recoveredAddress` must equal the
   * API key's derived address — but the verifier cannot derive
   * that address from the issuer DID alone. We pass it in.
   */
  additionalTrustedSignerAddresses?: ReadonlySet<string>;
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
  // Read VC_VERIFY_MODE first (legacy), fall back to T3_MODE
  // (canonical), then default to "live" for production safety.
  const raw = (
    process.env.VC_VERIFY_MODE ||
    process.env.T3_MODE ||
    "live"
  ).trim().toLowerCase();
  if (raw === "live" || raw === "structural") return raw;
  if (raw === "sandbox") return "sandbox";
  return "live";
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
  const {
    credential,
    agentDid,
    revokedAuthorityRefs,
    now = new Date(),
    additionalTrustedSignerAddresses,
  } = request;

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
  return tryLiveVerify(safe, agentDid, mode, additionalTrustedSignerAddresses);
}

/**
 * Extract an Ethereum address from a DID that embeds one.
 * Supports `did:ethr:0x...`, `did:t3n:0x...`, and `did:t3n:<hex>...`
 * formats (with or without `0x` prefix, with optional `#key-1` fragment).
 */
function walletAddressFromDid(did: string): string | null {
  // Match the 40-hex-char address segment, with or without `0x` prefix,
  // optionally preceded by a DID prefix and optionally followed by a fragment.
  const match = /^(?:did:[a-z0-9]+:)?((?:0x)?[0-9a-fA-F]{40})(?:#[^#]*)?$/u.exec(did);
  if (!match?.[1]) return null;
  let addr = match[1].toLowerCase();
  if (!addr.startsWith("0x")) addr = `0x${addr}`;
  return addr;
}

async function tryLiveVerify(
  safe: GhostbrokerDelegationCredential,
  agentDid: string,
  mode: GhostbrokerVerificationMode,
  additionalTrustedSignerAddresses?: ReadonlySet<string>,
): Promise<GhostbrokerVerificationResult> {
  try {
    // Re-implement ECDSA verification inline instead of delegating to
    // @terminal3/verify_vc → @terminal3/ecdsa_vc, because the latter's
    // `getWalletAddress` only supports `did:ethr:` DIDs and throws on
    // our `did:t3n:0x<address>` format. The verification logic is
    // straightforward:
    //
    //   1. Strip proof from the VC
    //   2. JSON.stringify the proof-stripped body (insertion order)
    //   3. keccak256(utf8 bytes of JSON)  →  32-byte digest
    //   4. ethers.verifyMessage(digest, proofValue)  →  recovered address
    //      (applies EIP-191 personal_sign prefix internally)
    //   5. Extract wallet address from the issuer DID
    //   6. Assert recovered address matches one of the trusted
    //      signer addresses (issuer DID address OR any address
    //      in `additionalTrustedSignerAddresses`)
    //      AND is present in proof.verificationMethod

    if (!safe.proof?.jws) {
      return { status: "rejected", agentDid, reason: "unverified" };
    }

    // Step 1: build the proof-stripped payload (same shape as what the
    // signer's `buildDelegationSigningBody` produces).
    const payload = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: safe.id,
      type: safe.type,
      issuer: safe.issuer,
      validFrom: safe.issuanceDate,
      validUntil: safe.expirationDate,
      credentialSubject: { ...safe.credentialSubject },
    };

    // Step 2-3: serialize and hash.
    const json = JSON.stringify(payload);
    const hash = keccak_256(new TextEncoder().encode(json));

    // Log the JSON being hashed so we can compare with what the signer produced.
    console.log(
      "[VERIFY] payload JSON:",
      json,
    );
    console.log(
      "[VERIFY] payload JSON length:",
      json.length,
      "hash hex:",
      Buffer.from(hash).toString("hex"),
    );

    // Step 4: recover the signer's address from the ECDSA signature.
    // `ethers.verifyMessage` applies the EIP-191 personal_sign prefix
    // internally and returns the recovered address.
    const recoveredAddress = ethers.verifyMessage(
      hash,
      safe.proof.jws as string,
    );

    // Step 5: build the set of trusted signer addresses.
    //
    // The primary trusted address is the one embedded in the issuer
    // DID — this is the standard W3C VC semantic that the issuer
    // claims the credential and signs it.
    //
    // Additional trusted addresses (e.g. the T3 SDK API key's derived
    // address) are passed by the caller. This is the production case:
    // the T3 SDK authenticates with the API key's address and the
    // server returns a tenant DID whose embedded address differs.
    // The signing identity on the wire is the API key holder; we
    // accept their signatures as authoritative for the tenant.
    const trustedAddresses = new Set<string>();
    const issuerAddress = walletAddressFromDid(safe.issuer);
    if (issuerAddress) {
      trustedAddresses.add(issuerAddress.toLowerCase());
    }
    if (additionalTrustedSignerAddresses) {
      for (const addr of additionalTrustedSignerAddresses) {
        trustedAddresses.add(addr.toLowerCase());
      }
    }

    if (trustedAddresses.size === 0) {
      console.warn(
        "[VERIFY] Could not extract wallet address from issuer DID and no additional trusted signers provided:",
        safe.issuer,
      );
      return { status: "rejected", agentDid, reason: "unverified" };
    }

    // Step 6: verify the recovered address matches one of the trusted addresses.
    const recoveredLower = recoveredAddress.toLowerCase();
    const addrMatch = trustedAddresses.has(recoveredLower);

    // Also verify the recovered address appears in the verificationMethod
    // for defense-in-depth. The signer embeds the additional trusted
    // signer's address (e.g. `did:ethr:0x<api-key-addr>#controller`) into
    // the verificationMethod alongside the issuer DID, so the
    // `includes()` check matches both cases.
    const vmMatch = safe.proof.verificationMethod
      .toLowerCase()
      .includes(recoveredLower);

    if (!addrMatch || !vmMatch) {
      console.warn(
        "[VERIFY] ECDSA signature mismatch",
        JSON.stringify({
          recoveredAddress,
          trustedAddresses: [...trustedAddresses],
          addrMatch,
          vmMatch,
          verificationMethod: safe.proof.verificationMethod,
        }),
      );
      return { status: "rejected", agentDid, reason: "unverified" };
    }

    return {
      status: "verified",
      agentDid,
      authorityRef: authorityRefFor(safe),
      policyHash: policyHashFor(safe),
      verificationMode: "live",
    };
  } catch (err) {
    console.warn(
      "[VERIFY] tryLiveVerify caught exception:",
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.stack : undefined,
    );
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

