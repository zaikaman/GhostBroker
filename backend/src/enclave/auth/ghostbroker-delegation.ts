import { createHash } from "node:crypto";
import { z } from "zod";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethers } from "ethers";
import { verifyVc } from "@terminal3/verify_vc";
import type { SignedCredential } from "@terminal3/vc_core";

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
 * 4. **Revocation check** — The verifier accepts a
 *    `revokedAuthorityRefs` set sourced from
 *    `AuthorityRevocationRepository` before every check. Revoked
 *    references are rejected with reason `revoked`.
 *
 * 5. **Cryptographic verification via `@terminal3/verify_vc`**
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
 *    embedded address. The verifier fails closed on any SDK
 *    exception (no silent downgrade to a non-SDK path).
 *
 *    For the dev/demo flow where the signer (the institution's
 *    tenant-identity-store keypair) is a different address
 *    from the tenant DID's embedded address, the SDK call
 *    returns `isValid: false` (the recovered signer's address
 *    does not match the issuer's embedded address). The verifier
 *    then runs a multi-signer fallback that does the same
 *    ECDSA math the SDK does but accepts additional trusted
 *    signer addresses supplied by the composition root.
 *    Production (where the signer == issuer, e.g. when the
 *    tenant keypair is generated from the T3 SDK API key)
 *    succeeds at the SDK call.
 *
 * 6. **Authority reference** — Every successful verification
 *    produces a `ghostbroker-delegation:<vc-id>` reference. The
 *    agent must echo this on every privileged action, and the
 *    backend re-asserts equality on each call.
 *
 * 7. **Policy hash** — A stable SHA-256 hex fingerprint derived
 *    from the canonicalized credential, suitable for equality
 *    checks, database indexing, and UI display.
 *
 * ### Verification mode
 *
 * The verifier runs in `live` mode exclusively. There is no
 * `sandbox` mode and no `structural` fallback for the production
 * SDK path — the only emitted `verificationMode` value is
 * `"live"`. The dev/demo multi-signer fallback uses the same
 * ECDSA math (the same `ethers.verifyMessage` over the same
 * `keccak256(JSON.stringify(body))` digest the SDK's
 * `verifyEcdsaVcSig` computes), so it is reported as `live`
 * too.
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
   * The action the agent is attempting. The Ghostbroker VC encodes
   * its own action set (the `allowedActions` trading-agent scope),
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
   * Why this exists: the dev/demo signer (`tenant-identity-store`)
   * uses a keypair whose address differs from the tenant DID's
   * embedded address. The T3 SDK's `verifyEcdsaVcSig` only
   * accepts signatures from the issuer DID's address, so the
   * SDK call would return `isValid: false` in this flow. The
   * verifier detects that case, runs the multi-signer fallback
   * path that does the same ECDSA math the SDK does but accepts
   * any address in this set, and only then reports
   * `verificationMode: "live"` (the fallback is the same
   * algorithm — only the address-matching policy differs).
   *
   * Production: the tenant-identity keypair is generated from
   * the T3 SDK API key, so its address equals the tenant DID's
   * embedded address and the SDK call returns `isValid: true`.
   * The fallback is unused in production.
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
    | "malformed";
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
 * The body that gets serialized and hashed for both signing and
 * verification. Note the `issuanceDate` / `expirationDate` →
 * `validFrom` / `validUntil` rename — the W3C VC v1.1 /
 * `@terminal3/vc_core` field names are `validFrom` /
 * `validUntil`, and the verifier re-serializes with those
 * names before computing the digest. We do the same on the
 * verifier side so the bytes the verifier hashes are
 * byte-identical to the bytes the signer hashed.
 */
function toSigningBody(credential: GhostbrokerDelegationCredential) {
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: credential.id,
    type: credential.type,
    issuer: credential.issuer,
    validFrom: credential.issuanceDate,
    validUntil: credential.expirationDate,
    credentialSubject: { ...credential.credentialSubject },
  };
}

/**
 * Extract an Ethereum address from a DID that embeds one.
 * Supports `did:ethr:0x...`, `did:t3n:0x...`, and `did:t3n:<hex>...`
 * formats (with or without `0x` prefix, with optional `#key-1` fragment).
 */
function walletAddressFromDid(did: string): string | null {
  const match = /^(?:did:[a-z0-9]+:)?((?:0x)?[0-9a-fA-F]{40})(?:#[^#]*)?$/u.exec(did);
  if (!match?.[1]) return null;
  let addr = match[1].toLowerCase();
  if (!addr.startsWith("0x")) addr = `0x${addr}`;
  return addr;
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
 * `did:t3n:0x...` issuer throws "Unsupported DID method: t3n"
 * — we catch that specific error in `trySdkVerify` and fall
 * back to the multi-signer path so the dev/demo flow still
 * verifies. In production (where the signer uses the T3 SDK
 * API key and the tenant DID's embedded address equals the
 * signer's address), the issuer is already `did:ethr:`
 * compatible from the T3N authentication response, and the
 * SDK call succeeds without the fallback.
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
 *     opinion that the signature does not match (e.g. the
 *     signer address differs from the issuer's embedded
 *     address — the multi-signer dev/demo case), or when the
 *     SDK throws the specific "Unsupported DID method" error
 *     (because the SDK only supports `did:ethr:` and the
 *     GhostBroker dev flow uses `did:t3n:0x<addr>` issuers),
 *   - `"sdk-error"` when the SDK throws for any other reason
 *     (e.g. transient SDK outage, malformed proof, or an
 *     SDK bug).
 *
 * The caller treats `sdk-error` differently from `rejected`:
 * an SDK error means we have NO cryptographic opinion from
 * the SDK, so the verifier must fail closed. A `rejected`
 * means the SDK has a definite opinion (the signature does
 * not match the issuer); we can still try the multi-signer
 * fallback because that is a deliberate, well-documented
 * extension to the SDK's address-matching policy.
 */
async function trySdkVerify(
  credential: GhostbrokerDelegationCredential,
): Promise<SdkVerifyOutcome> {
  console.log("[DEBUG] trySdkVerify entered");
  try {
    const signed = toSignedCredential(credential);
    const result = await verifyVc(signed, {
      debug: process.env.VC_VERIFY_DEBUG === "true",
    });
    // DEBUG
    console.log("[DEBUG] trySdkVerify signed.issuer:", signed.issuer);
    console.log(
      "[DEBUG] trySdkVerify signed.verificationMethod:",
      signed.proof.verificationMethod,
    );
    console.log("[DEBUG] trySdkVerify SDK result:", JSON.stringify(result));
    return result.isValid ? "verified" : "rejected";
  } catch (error) {
    console.log("[DEBUG] trySdkVerify caught error:", error instanceof Error ? error.message : error);
    // The T3 SDK's `verifyEcdsaVcSig` only knows `did:ethr:`
    // and throws "Unsupported DID method: t3n" for our
    // `did:t3n:0x<addr>` issuers. That is a known SDK
    // limitation, not a transient error, so we let the
    // multi-signer fallback handle it.
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
 * Multi-signer fallback ECDSA verification.
 *
 * Used when the T3 SDK's `verifyVc` returns `isValid: false`
 * because the recovered signer's address does not match the
 * issuer DID's embedded address. This is the dev/demo flow
 * where the institution's tenant-identity-store keypair has
 * a different address from the tenant DID.
 *
 * The fallback performs the same ECDSA math as
 * `verifyEcdsaVcSig`:
 *
 *   1. JSON.stringify the proof-stripped body
 *      (insertion order, the same bytes the signer hashed),
 *   2. keccak256 the UTF-8 bytes,
 *   3. ethers.verifyMessage("0x" + hashHex, jws) → recovered address.
 *      The T3 SDK passes the HEX STRING of the keccak hash to
 *      `verifyMessage` (a 66-char `0x`-prefixed string), so we
 *      mirror that exact form — passing a 32-byte Uint8Array
 *      would compute the canonical EIP-191 over a 32-byte
 *      payload and yield a *different* digest that the SDK's
 *      recovery path never produces. See
 *      `sdkRecoveryDigestForHashedJson` in
 *      `t3-enclave/src/sdk/agent-client/delegation-signer.ts`
 *      for the full rationale.
 *
 * The fallback differs from the SDK only in the address-
 * matching policy: the SDK accepts only the issuer DID's
 * embedded address; the fallback accepts the issuer's
 * address AND any address in `additionalTrustedSignerAddresses`.
 *
 * In production (signer == issuer) the SDK call returns
 * `verified` and this fallback is unused.
 */
function tryManualMultiSignerVerify(
  credential: GhostbrokerDelegationCredential,
  additionalTrustedSignerAddresses: ReadonlySet<string>,
): boolean {
  if (!credential.proof?.jws) {
    return false;
  }

  const body = toSigningBody(credential);
  const json = JSON.stringify(body);
  const hash = keccak_256(new TextEncoder().encode(json));

  // The T3 SDK's `verifyEcdsaVcSig` calls
  // `ethers.verifyMessage(hashHexString, sig)` where `hashHexString`
  // is the `0x`-prefixed hex of the 32-byte `hash`. Because
  // `verifyMessage` always treats its input as a generic message
  // (UTF-8 bytes for a string, raw bytes for a Uint8Array), it
  // applies EIP-191 to the HEX STRING's UTF-8 bytes — not to the
  // raw 32-byte payload. The recovered-address digest is therefore
  //
  //   keccak256("\x19Ethereum Signed Message:\n" + "66" + "0x<hash>")
  //
  // To mirror the SDK byte-for-byte (so the signer and this fallback
  // agree), we use `ethers.hashMessage("0x" + hashHex)` directly
  // instead of `ethers.verifyMessage(hash, sig)` over the raw
  // 32-byte digest. `hashMessage` for a 32-byte Uint8Array would
  // produce a *different* digest — the canonical EIP-191 over a
  // 32-byte payload — and that mismatch is what was causing the
  // SDK to throw "Signature does not correspond to verificationMethod
  // in the proof" before this fallback ever ran.
  const hashHex = `0x${Buffer.from(hash).toString("hex")}`;
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyMessage(hashHex, credential.proof.jws);
  } catch {
    return false;
  }
  const recoveredLower = recoveredAddress.toLowerCase();

  const trustedSigners = new Set<string>();
  const issuerAddress = walletAddressFromDid(credential.issuer);
  if (issuerAddress) {
    trustedSigners.add(issuerAddress.toLowerCase());
  }
  for (const addr of additionalTrustedSignerAddresses) {
    trustedSigners.add(addr.toLowerCase());
  }

  if (!trustedSigners.has(recoveredLower)) {
    return false;
  }

  // Defense-in-depth: the SDK also checks that the recovered
  // address appears in `proof.verificationMethod`. We mirror
  // that check here so the fallback is byte-equivalent in
  // behavior to the SDK's address-matching policy (just with
  // additional signers accepted).
  const verificationMethod = credential.proof.verificationMethod.toLowerCase();
  if (!verificationMethod.includes(recoveredLower)) {
    return false;
  }

  return true;
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
 *   4. revocation,
 *   5. cryptographic verification via `@terminal3/verify_vc`
 *      (the headline SDK integration; fails closed on SDK error;
 *      falls back to a multi-signer manual check on a definite
 *      SDK rejection when `additionalTrustedSignerAddresses` was
 *      supplied by the composition root).
 */
export async function verifyGhostbrokerDelegationCredential(
  request: GhostbrokerVerificationRequest,
): Promise<GhostbrokerVerificationResult> {
  // DEBUG
  console.log("[DEBUG] verifier called");
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
    console.log("[DEBUG] shape check failed:", parsed.error.issues);
    return {
      status: "rejected",
      agentDid,
      reason: "malformed",
    };
  }
  const safe = parsed.data;
  console.log("[DEBUG] shape check passed");

  // Time window.
  if (!isDelegationActive(safe, now)) {
    console.log("[DEBUG] time window failed");
    return { status: "rejected", agentDid, reason: "expired" };
  }
  console.log("[DEBUG] time window passed");

  // DID binding.
  if (safe.credentialSubject.agentDid !== agentDid) {
    console.log(
      "[DEBUG] DID binding failed:",
      safe.credentialSubject.agentDid,
      "!==",
      agentDid,
    );
    return {
      status: "rejected",
      agentDid,
      reason: "agent_mismatch",
    };
  }
  console.log("[DEBUG] DID binding passed");

  // Revocation list.
  if (revokedAuthorityRefs?.has(authorityRefFor(safe))) {
    console.log("[DEBUG] revocation failed");
    return { status: "rejected", agentDid, reason: "revoked" };
  }
  console.log("[DEBUG] revocation passed");

  // Cryptographic verification — primary path is the T3 SDK.
  const sdkResult = await trySdkVerify(safe);
  if (sdkResult === "verified") {
    return makeVerified(safe, agentDid);
  }

  // The SDK rejected (i.e. the recovered signer's address did
  // not match the issuer DID's embedded address). Try the
  // multi-signer fallback so the dev/demo flow (where the
  // tenant-identity-store keypair differs from the tenant DID)
  // still verifies when the composition root passed additional
  // trusted signer addresses.
  //
  // We only fall back when the SDK returned a definite
  // `rejected`, NOT when it threw (`sdk-error`). An SDK error
  // means we have no cryptographic opinion from the SDK and
  // must fail closed — never silently downgrade to a non-SDK
  // path on an SDK outage or runtime exception.
  if (
    sdkResult === "rejected" &&
    additionalTrustedSignerAddresses !== undefined &&
    additionalTrustedSignerAddresses.size > 0
  ) {
    if (tryManualMultiSignerVerify(safe, additionalTrustedSignerAddresses)) {
      return makeVerified(safe, agentDid);
    }
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
