import { createHash } from "node:crypto";
import { z } from "zod";
import { ethers } from "ethers";
import { verifyVc } from "@terminal3/verify_vc";
import type { SignedCredential } from "@terminal3/vc_core";
import { logger } from "../../logging/logger.js";

/**
 * The action an agent is attempting on the backend. Used as the
 * discriminator across the agent authorization surface
 * (admit / intent.submit / intent.cancel / settlement.execute /
 * negotiation.*). The Ghostbroker delegation verifier enforces
 * that `credentialSubject.allowedActions` contains the requested
 * action — a VC scoped only to `["agent.admit"]` cannot be used
 * for `intent.submit`, `settlement.execute`, or any negotiation
 * action.
 */
export type RequestedAgentAction =
  | "agent.admit"
  | "intent.submit"
  | "intent.cancel"
  | "settlement.execute"
  | "negotiation.open"
  | "negotiation.move"
  | "negotiation.disclose"
  | "negotiation.settle";

/**
 * Ghostbroker-style W3C Verifiable Credential verifier for an
 * agent's delegation.
 *
 * This module is the project's W3C JSON-LD VC verifier for the
 * delegation a buyer institution issues to its agent. It is the
 * headline integration of the Terminal 3 Agent Dev Kit bounty:
 * every privileged backend action (`agent.admit`,
 * `intent.submit`, `settlement.execute`, `negotiation.*`)
 * re-runs this verifier on the persisted VC before allowing the
 * action.
 *
 * ### Verification pipeline
 *
 * 1. **Shape validation** — Zod schema parse (`ghostbrokerDelegationSchema`)
 *    enforces `id`, `issuer`, `credentialSubject.agentDid`,
 *    `credentialSubject.allowedActions`, `issuanceDate`,
 *    `expirationDate`, and `proof` object presence.
 *
 * 2. **Time-window enforcement** — The credential's
 *    `issuanceDate` and `expirationDate` are validated against
 *    the current server time. Expired credentials are rejected
 *    with reason `expired`.
 *
 * 3. **DID binding** — The credential's
 *    `credentialSubject.agentDid` must exactly match the agent
 *    DID on the incoming request. A mismatch yields
 *    `agent_mismatch`.
 *
 * 4. **Action scope** — The credential's
 *    `credentialSubject.allowedActions` must include the
 *    `requestedAction` on the incoming request. This is the
 *    load-bearing check that makes the "authority-bound" claim
 *    real: a VC scoped only to `["agent.admit"]` cannot be used
 *    to submit intents, settle, or move in a negotiation. A
 *    mismatch yields `action_not_allowed`.
 *
 * 5. **Revocation check** — The verifier accepts a
 *    `revokedAuthorityRefs` set sourced from
 *    `AuthorityRevocationRepository` before every check. Revoked
 *    references are rejected with reason `revoked`.
 *
 * 6. **Cryptographic verification via `@terminal3/verify_vc`**
 *    — The verifier calls `verifyVc(signedCredential)` from
 *    `@terminal3/verify_vc`. The verifier normalizes the
 *    Ghostbroker-style VC into the `SignedCredential` shape the
 *    SDK expects (renaming `issuanceDate`→`validFrom`,
 *    `expirationDate`→`validUntil`, `jws`→`proofValue`, and
 *    converting `did:t3n:0x<addr>` to `did:ethr:0x<addr>`
 *    with EIP-55 checksum-cased addresses). The SDK's
 *    `verifyEcdsaVcSig` recovers the signer's address from the
 *    EIP-191 personal_sign over `keccak256(JSON.stringify(body))`,
 *    and asserts the recovered address matches the issuer DID's
 *    embedded address.
 *
 *    The SDK is the SOLE cryptographic path. There is no manual
 *    fallback. Server-minted VCs guarantee `signer == issuer`
 *    (the issuer DID is derived from the same keypair that signs
 *    the credential — see `tenant-identity-store.ts` for the
 *    C1 fix); the SDK call returns `isValid: true` on the happy
 *    path. Any other outcome (recovered signer does not match
 *    the issuer DID; the SDK throws on a `did:t3n:` issuer;
 *    an SDK outage) fails closed with reason `unverified`.
 *
 * 7. **Authority reference** — Every successful verification
 *    produces a `ghostbroker-delegation:<vc-id>` reference. The
 *    agent must echo this on every privileged action, and the
 *    backend re-asserts equality on each call.
 *
 * 8. **Policy hash** — A stable SHA-256 hex fingerprint derived
 *    from the canonicalized credential, suitable for equality
 *    checks, database indexing, and UI display.
 *
 * ### Verification mode
 *
 * The verifier runs in `live` mode exclusively. There is no
 * `sandbox` mode, no `structural` fallback, and no multi-signer
 * fallback — the SDK is the only cryptographic authority, and
 * the only emitted `verificationMode` value is `"live"`.
 */

const delegationActionScopeSchema = z.enum([
  "agent.admit",
  "intent.submit",
  "intent.cancel",
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

/**
 * The verifier's single verification mode. Cryptographic
 * verification is always performed — there is no structural
 * fallback.
 */
export type GhostbrokerVerificationMode = "live";

export interface GhostbrokerVerificationRequest {
  credential: unknown;
  institutionId: string;
  agentDid: string;
  /**
   * The action the agent is attempting. The verifier enforces
   * that `credentialSubject.allowedActions` contains this value
   * before allowing any action through — a VC scoped only to
   * `["agent.admit"]` cannot be used to submit intents, settle,
   * or move in a negotiation. Every caller (`agent.admit`,
   * `intent.submit`, `intent.cancel`, `settlement.execute`,
   * `negotiation.open`, `negotiation.move`,
   * `negotiation.disclose`, `negotiation.settle`) is required
   * to pass the action that matches the route it is invoking.
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
    | "action_not_allowed";
}

export type GhostbrokerVerificationResult =
  | VerifiedGhostbrokerDelegation
  | RejectedGhostbrokerDelegation;

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

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`,
      )
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
 * EIP-55 checksum-cased form of a hex address. The T3 SDK's
 * `verifyEcdsaVcSig` recovers the signer address from
 * `ethers.verifyMessage`, which returns the EIP-55 checksummed
 * form. The SDK then compares it case-sensitively against the
 * issuer DID's embedded address and the
 * `proof.verificationMethod` substring — so both must use the
 * EIP-55 checksummed form for the check to pass.
 */
function toEip55Address(raw: string): string {
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  try {
    return ethers.getAddress(prefixed);
  } catch {
    return raw;
  }
}

/**
 * Normalize a DID that embeds an Ethereum address into its
 * EIP-55 checksummed `did:ethr:` form. Non-address DIDs
 * (sandbox markers, fragment-only IDs, etc.) pass through
 * unchanged.
 *
 * Used to map a `did:t3n:0x<addr>` to `did:ethr:0x<checksum>` so
 * the T3 SDK's `verifyEcdsaVcSig` (which only knows
 * `did:ethr:`) accepts it.
 */
function toEip55Did(did: string): string {
  const match = /^did:[a-z0-9]+:((?:0x)?[0-9a-fA-F]{40})(?:#.*)?$/iu.exec(did);
  if (!match?.[1]) return did;
  const checksummed = toEip55Address(match[1]);
  return did.replace(match[1], checksummed).replace(/^did:[a-z0-9]+:/iu, "did:ethr:");
}

/**
 * Convert the Ghostbroker-style credential into the
 * `SignedCredential` shape that `@terminal3/verify_vc`'s
 * `verifyVc` expects. The conversion:
 *
 *   - renames `issuanceDate` / `expirationDate` →
 *     `validFrom` / `validUntil`,
 *   - renames `proof.jws` → `proof.proofValue`,
 *   - normalizes the `proof.verificationMethod` to use
 *     EIP-55 checksummed address forms so the SDK's
 *     case-sensitive substring check
 *     (`includes(recoveredAddress)`) matches the recovered
 *     address.
 *
 * IMPORTANT: the issuer DID and the `credentialSubject` are
 * NOT transformed. The signer hashes the proof-stripped body
 * (with the original issuer and credentialSubject) with
 * `keccak256(JSON.stringify(body))`; if we change the issuer
 * here, the SDK's hash recomputation produces a different
 * digest and the signature no longer matches. The SDK's
 * `getWalletAddress` only supports `did:ethr:` so a
 * `did:t3n:0x...` issuer throws "Unsupported DID method: t3n".
 * `trySdkVerify` catches that specific error and reports it
 * as a definite `rejected` (not an `sdk-error`), so the
 * verifier fails closed with reason `unverified` — there is
 * no multi-signer fallback path. In production (where the
 * signer's keypair derived address is the canonical `did:ethr:`
 * issuer — see `tenant-identity-store.ts`), the issuer is
 * already `did:ethr:` compatible, and the SDK call returns
 * `isValid: true` directly.
 */
function toSignedCredential(
  credential: GhostbrokerDelegationCredential,
): SignedCredential {
  const proof = credential.proof;
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: credential.id as `${string}:${string}`,
    type: credential.type,
    issuer: credential.issuer as `did:${string}:${string}`,
    validFrom: credential.issuanceDate,
    validUntil: credential.expirationDate,
    credentialSubject: {
      ...credential.credentialSubject,
      id: credential.credentialSubject.id as `did:${string}:${string}`,
    },
    proof: {
      type: proof?.type ?? "",
      proofPurpose: proof?.proofPurpose ?? "",
      verificationMethod: (proof?.verificationMethod ?? "")
        .split(/\s+/u)
        .map((part) => toEip55Did(part))
        .filter((part) => part.length > 0)
        .join(" "),
      created: proof?.created ?? "",
      proofValue: proof?.jws ?? "",
    },
  };
}

type SdkVerifyOutcome = "verified" | "rejected" | "sdk-error";

/**
 * Call `@terminal3/verify_vc`'s `verifyVc` on the normalized
 * VC. Returns:
 *   - `"verified"` when the SDK confirms the signature,
 *   - `"rejected"` when the SDK has a definite cryptographic
 *     opinion that the signature does not match (the recovered
 *     signer address differs from the issuer's embedded
 *     address), or when the SDK throws the specific
 *     "Unsupported DID method" error (because the SDK only
 *     supports `did:ethr:` and legacy `did:t3n:0x<addr>`
 *     issuers hit that path),
 *   - `"sdk-error"` when the SDK throws for any other reason
 *     (e.g. transient SDK outage, malformed proof, or an
 *     SDK bug).
 *
 * Both `"rejected"` and `"sdk-error"` cause the verifier to
 * fail closed with reason `unverified`. The SDK is the only
 * cryptographic authority — there is no manual fallback path.
 */
async function trySdkVerify(
  credential: GhostbrokerDelegationCredential,
): Promise<SdkVerifyOutcome> {
  logger.debug("trySdkVerify entered");
  try {
    const signed = toSignedCredential(credential);
    const result = await verifyVc(signed, {
      debug: process.env.VC_VERIFY_DEBUG === "true",
    });
    logger.debug(
      {
        issuer: signed.issuer,
        verificationMethod: signed.proof.verificationMethod,
        sdkResult: result,
      },
      "trySdkVerify SDK verification outcome",
    );
    return result.isValid ? "verified" : "rejected";
  } catch (error) {
    logger.debug(
      {
        err: error instanceof Error ? error.message : String(error),
      },
      "trySdkVerify caught error",
    );
    // The T3 SDK's `verifyEcdsaVcSig` only knows `did:ethr:`
    // and throws "Unsupported DID method: t3n" for our
    // `did:t3n:0x<addr>` issuers. That is a known SDK
    // limitation, not a transient error. Production server-
    // minted VCs use `did:ethr:0x<keypair>` issuers (see
    // `tenant-identity-store.ts`), so this case does not
    // occur on the happy path; the verifier fails closed on
    // it with reason `unverified`. We still distinguish the
    // error from a transient SDK outage below.
    if (
      error instanceof Error &&
      /Unsupported DID method/i.test(error.message)
    ) {
      return "rejected";
    }
    // Any other exception (network, bug, malformed proof)
    // is treated as a transient SDK error: fail closed.
    return "sdk-error";
  }
}

/**
 * Verify a Ghostbroker-style W3C VC. Returns a discriminated
 * union shaped to match `verifySignedDelegationProof`'s
 * output so the facade can consume either verifier's result
 * interchangeably.
 *
 * Pipeline (see file doc):
 *   1. shape (Zod),
 *   2. time window,
 *   3. DID binding,
 *   4. action scope (requestedAction ∈ allowedActions),
 *   5. revocation,
 *   6. cryptographic verification via `@terminal3/verify_vc`
 *      (the headline SDK integration). The SDK is the SOLE
 *      cryptographic path — there is no manual fallback. The
 *      SDK call returns `verified` when the recovered signer's
 *      address matches the issuer DID's embedded address, which
 *      is guaranteed to hold for server-minted VCs because the
 *      issuer DID is derived from the same keypair that signs
 *      them (see `tenant-identity-store.ts` for the C1 fix).
 */
export async function verifyGhostbrokerDelegationCredential(
  request: GhostbrokerVerificationRequest,
): Promise<GhostbrokerVerificationResult> {
  logger.debug("verifier called");
  const {
    credential,
    agentDid,
    revokedAuthorityRefs,
    now = new Date(),
  } = request;

  // Shape check (defensive — caller should have parsed already).
  const parsed = ghostbrokerDelegationSchema.safeParse(credential);
  if (!parsed.success) {
    logger.debug(
      { issues: parsed.error.issues },
      "shape check failed",
    );
    return {
      status: "rejected",
      agentDid,
      reason: "malformed",
    };
  }
  const safe = parsed.data;
  logger.debug("shape check passed");

  // Time window.
  if (!isDelegationActive(safe, now)) {
    logger.debug("time window failed");
    return { status: "rejected", agentDid, reason: "expired" };
  }
  logger.debug("time window passed");

  // DID binding.
  if (safe.credentialSubject.agentDid !== agentDid) {
    logger.debug(
      {
        vcAgentDid: safe.credentialSubject.agentDid,
        requestAgentDid: agentDid,
      },
      "DID binding failed",
    );
    return {
      status: "rejected",
      agentDid,
      reason: "agent_mismatch",
    };
  }
  logger.debug("DID binding passed");

  // Action scope. The VC encodes its own action set
  // (`credentialSubject.allowedActions`); the request encodes
  // what the agent is actually trying to do. The two must
  // agree. This is the load-bearing check that makes the
  // "authority-bound" claim real: a VC scoped only to
  // `["agent.admit"]` cannot be used to submit intents,
  // settle, or move in a negotiation, regardless of how the
  // orchestrator routes the call downstream.
  if (!safe.credentialSubject.allowedActions.includes(request.requestedAction)) {
    logger.debug(
      {
        allowedActions: safe.credentialSubject.allowedActions,
        requestedAction: request.requestedAction,
      },
      "action scope failed",
    );
    return {
      status: "rejected",
      agentDid,
      reason: "action_not_allowed",
    };
  }
  logger.debug("action scope passed");

  // Revocation list.
  if (revokedAuthorityRefs?.has(authorityRefFor(safe))) {
    logger.debug("revocation failed");
    return { status: "rejected", agentDid, reason: "revoked" };
  }
  logger.debug("revocation passed");

  // Cryptographic verification — primary (and only) path is the
  // T3 SDK. Server-minted VCs have `signer == issuer` because
  // the issuer DID is derived from the same keypair that signs
  // the credential (see `tenant-identity-store.ts`); the SDK's
  // `verifyEcdsaVcSig` matches the issuer's embedded address
  // against the recovered signer and returns `isValid: true`.
  // Any other outcome (the recovered signer doesn't match the
  // issuer DID; the SDK throws on a `did:t3n:` issuer; an SDK
  // outage) fails closed — there is no manual fallback path.
  const sdkResult = await trySdkVerify(safe);
  if (sdkResult === "verified") {
    return makeVerified(safe, agentDid);
  }

  return { status: "rejected", agentDid, reason: "unverified" };
}

function makeVerified(
  credential: GhostbrokerDelegationCredential,
  agentDid: string,
): VerifiedGhostbrokerDelegation {
  return {
    status: "verified",
    agentDid,
    authorityRef: authorityRefFor(credential),
    policyHash: policyHashFor(credential),
    verificationMode: "live",
  };
}
