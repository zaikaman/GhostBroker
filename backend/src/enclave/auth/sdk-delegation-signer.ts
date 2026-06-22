import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "node:crypto";
import {
  buildDelegationCredential,
  canonicaliseCredential,
  signCredential,
  buildInvocationPreimage,
  signAgentInvocation,
  revokeDelegation,
  type DelegationCredential as SdkDelegationCredential,
  type RevokeDelegationResult,
  type T3nClient,
  VC_ID_LEN,
  NONCE_LEN,
  REQUEST_HASH_LEN,
} from "@terminal3/t3n-sdk";
import type { TenantIdentity } from "../sandbox/tenant-identity-store.js";
import {
  mintDelegationCredentialBody,
  signDelegationCredential,
  type DelegationCredential,
  type DelegationActionScope,
} from "../../sdk/agent-client/index.js";
import { logger } from "../../logging/logger.js";

/**
 * SDK-native delegation signer using the Terminal 3 SDK's
 * buildDelegationCredential / canonicaliseCredential /
 * signCredential / signAgentInvocation / revokeDelegation
 * primitives (t3n-sdk v3.9.0+).
 *
 * This module is the default minting path for tenant delegation
 * credentials. It produces two artifacts:
 *
 *  1. An SDK-native `DelegationCredential` (the SDK's own
 *     JCS-canonicalised, EIP-191-signed shape) - used for
 *     on-chain revocation via `revokeDelegation` and for
 *     per-call agent invocation signatures via
 *     `signAgentInvocation`.
 *
 *  2. A W3C VC (`DelegationCredential` from the agent-client
 *     SDK) - the existing shape the backend's
 *     `@terminal3/verify_vc`-backed verifier in
 *     `ghostbroker-delegation.ts` cryptographically verifies on
 *     every privileged call. The verify side is unchanged.
 *
 * The old `delegation-signer.ts` in
 * `backend/src/sdk/agent-client/` remains as a legacy fallback
 * for environments where the SDK delegation contract is not
 * provisioned.
 */

/**
 * GhostBroker's matching contract id on T3N. The SDK
 * credential's `contract` field identifies which TEE contract
 * the delegation authorises the agent to invoke.
 */
const MATCHING_CONTRACT_ID = "tee:matching";

/**
 * Maps GhostBroker's action scope (the `allowedActions` enum
 * the verifier and orchestrator enforce) to the matching
 * contract's actual WIT function names. The SDK credential's
 * `functions` field takes WIT function names; the TEE contract
 * gate-checks that the credential authorises the function the
 * agent is invoking.
 *
 * Actions that are backend-level gates (agent.admit,
 * intent.cancel, settlement.execute) have no direct TEE
 * contract function - they are carried as synthetic function
 * names so the credential's function scope is semantically
 * complete, and the full original action set is also preserved
 * in the credential's `metadata` labels for the backend to
 * enforce.
 */
const ACTION_TO_WIT_FUNCTION: ReadonlyMap<DelegationActionScope, string> = new Map([
  ["agent.admit", "agent-admit"],
  ["intent.submit", "seal-intent"],
  ["intent.cancel", "cancel-intent"],
  ["settlement.execute", "settlement-execute"],
  ["negotiation.open", "seal-ticket"],
  ["negotiation.move", "seal-round-proposal"],
  ["negotiation.disclose", "seal-round-proposal"],
  ["negotiation.settle", "evaluate-round"],
]);

/**
 * The SDK-native delegation envelope: the JCS-canonicalised
 * credential bytes, the EIP-191 signature over those bytes, and
 * the credential's 16-byte id - all in base64url-no-pad encoding
 * (the wire format `revokeDelegation` expects). Also carries the
 * per-call agent invocation keypair the agent process uses with
 * `signAgentInvocation`.
 */
export interface SdkDelegationEnvelope {
  /** base64url-no-pad of the JCS-canonicalised credential bytes. */
  credentialJcsB64u: string;
  /** base64url-no-pad of the 65-byte EIP-191 signature. */
  userSigB64u: string;
  /** base64url-no-pad of the 16-byte credential id. */
  vcIdB64u: string;
  /** The WIT function names the credential authorises. */
  functions: string[];
  /**
   * 0x-prefixed 32-byte hex private key the agent uses for
   * `signAgentInvocation`. Generated fresh per credential and
   * stored alongside the VC so the agent process can sign
   * per-call invocations without holding the tenant signing key.
   */
  agentInvocationPrivateKey: string;
  /** 0x-prefixed 33-byte compressed public key matching the above. */
  agentInvocationPublicKey: string;
}

export interface SdkMintResult {
  /** The W3C VC the existing verifyVc path verifies. */
  credential: DelegationCredential;
  /** The SDK-native delegation envelope for revocation + invocation. */
  sdkEnvelope: SdkDelegationEnvelope;
}

export interface SdkDelegationPolicy {
  agentDid: string;
  institutionId: string;
  maxSpendUsd: number;
  allowedActions: readonly DelegationActionScope[];
  approverEmail?: string;
  purpose?: string;
  validityMonths?: number;
}

/**
 * Convert an Ethereum address (with or without 0x prefix) to
 * the SDK's `did:t3n:<40-hex>` CompactDid format (no 0x prefix).
 */
function toSdkDid(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/u, "");
  if (!/^[0-9a-f]{40}$/u.test(hex)) {
    throw new Error(
      `toSdkDid: expected a 40-hex Ethereum address, got ${address}`,
    );
  }
  return `did:t3n:${hex}`;
}

/**
 * base64url-no-pad encoding (RFC 4648 section 5 without padding).
 * Matches the SDK's `b64uEncodeBytes` wire encoding.
 */
function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Map the policy's allowedActions to the sorted, deduped WIT
 * function names the SDK credential's `functions` field
 * requires. The SDK enforces: non-empty, sorted ascending,
 * deduped, each entry non-empty lowercase ASCII, max 16 entries.
 */
function mapActionsToFunctions(
  actions: readonly DelegationActionScope[],
): string[] {
  const functionSet = new Set<string>();
  for (const action of actions) {
    const fn = ACTION_TO_WIT_FUNCTION.get(action);
    if (fn) {
      functionSet.add(fn);
    }
  }
  return [...functionSet].sort();
}

/**
 * Build the flat key-value metadata labels the SDK credential
 * carries. The TEE contract checks these against the org grant's
 * constraints; the backend also reads them to enforce the full
 * action scope (including backend-only actions that have no WIT
 * function).
 */
function buildMetadata(
  policy: SdkDelegationPolicy,
): Record<string, string> {
  const metadata: Record<string, string> = {
    allowed_actions: policy.allowedActions.join(","),
    max_spend_usd: String(policy.maxSpendUsd),
    institution_id: policy.institutionId,
  };
  if (policy.approverEmail) {
    metadata.approver_email = policy.approverEmail;
  }
  if (policy.purpose) {
    metadata.purpose = policy.purpose;
  }
  return metadata;
}

/**
 * Mint a delegation credential using the SDK's native lifecycle:
 * buildDelegationCredential -> canonicaliseCredential ->
 * signCredential. Also produces a W3C VC (via the existing
 * signer) so the current verifyVc path continues to work
 * unchanged.
 *
 * The SDK credential is signed by the institution's tenant
 * keypair (the same key that signs the W3C VC). A fresh agent
 * invocation keypair is generated for the SDK credential's
 * `agent_pubkey` - the agent process uses this key for
 * per-call `signAgentInvocation` signatures, separate from the
 * tenant signing key.
 */
export function mintSdkDelegation(
  policy: SdkDelegationPolicy,
  identity: Pick<TenantIdentity, "did" | "publicKey" | "privateKey" | "address">,
): SdkMintResult {
  const functions = mapActionsToFunctions(policy.allowedActions);
  if (functions.length === 0) {
    throw new Error(
      "mintSdkDelegation: allowedActions must map to at least one WIT function.",
    );
  }

  // Generate a fresh agent invocation keypair for the SDK
  // credential's agent_pubkey. The agent process uses this key
  // to sign per-call invocations via signAgentInvocation; the
  // TEE contract verifies the signature against this pubkey.
  const agentInvocationPrivateKeyBytes = randomBytes(32);
  const agentInvocationPublicKeyBytes = secp256k1.getPublicKey(
    agentInvocationPrivateKeyBytes,
    true,
  );

  // The SDK credential's user_did must be the did:t3n:<40-hex>
  // form. The tenant identity's address is the Ethereum address
  // derived from the signing keypair; signCredential will
  // recover this address from the EIP-191 signature, and the
  // TEE contract asserts equality with user_did.
  const userDid = toSdkDid(identity.address);
  const orgDid = userDid; // single-tenant model: institution is both user and org

  // 16-byte random credential id.
  const vcId = randomBytes(VC_ID_LEN);

  const now = Math.floor(Date.now() / 1000);
  const validityMonths = policy.validityMonths ?? 6;
  const notAfter = now + validityMonths * 30 * 24 * 60 * 60;

  // Build the SDK-native credential body.
  const sdkCredential: SdkDelegationCredential = buildDelegationCredential({
    user_did: userDid,
    agent_pubkey: agentInvocationPublicKeyBytes,
    org_did: orgDid,
    contract: MATCHING_CONTRACT_ID,
    functions,
    scopes: [],
    metadata: buildMetadata(policy),
    not_before_secs: BigInt(now),
    not_after_secs: BigInt(notAfter),
    vc_id: vcId,
  });

  // Canonicalise to RFC 8785 JCS bytes and sign with the
  // tenant's private key. signCredential returns the 65-byte
  // EIP-191 signature and the recovered 20-byte address.
  const jcs = canonicaliseCredential(sdkCredential);
  const privateKeyBytes = Uint8Array.from(
    Buffer.from(identity.privateKey.slice(2), "hex"),
  );
  const { sig } = signCredential(jcs, privateKeyBytes);

  // Also produce a W3C VC using the existing signer so the
  // current verifyVc path in ghostbroker-delegation.ts continues
  // to work unchanged. The W3C VC and the SDK credential are two
  // representations of the same delegation, both signed by the
  // same tenant keypair.
  const w3cBody = mintDelegationCredentialBody({
    agentDid: policy.agentDid,
    issuerDid: identity.did,
    maxSpendUsd: policy.maxSpendUsd,
    allowedActions: [...policy.allowedActions] as DelegationActionScope[],
    ...(policy.approverEmail ? { approverEmail: policy.approverEmail } : {}),
    ...(policy.purpose ? { purpose: policy.purpose } : {}),
    ...(policy.validityMonths ? { validityMonths: policy.validityMonths } : {}),
  });

  const didAddress = identity.did
    .toLowerCase()
    .match(/0x[0-9a-f]{40}/u)?.[0];
  const includeExtraSigner = didAddress !== identity.address.toLowerCase();

  const w3cCredential = signDelegationCredential(w3cBody, {
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
    issuerDid: identity.did,
    ...(includeExtraSigner
      ? {
          additionalSignerVerificationMethod: `did:ethr:${identity.address}#controller`,
        }
      : {}),
  });

  const sdkEnvelope: SdkDelegationEnvelope = {
    credentialJcsB64u: b64u(jcs),
    userSigB64u: b64u(sig),
    vcIdB64u: b64u(vcId),
    functions,
    agentInvocationPrivateKey: `0x${Buffer.from(agentInvocationPrivateKeyBytes).toString("hex")}`,
    agentInvocationPublicKey: `0x${Buffer.from(agentInvocationPublicKeyBytes).toString("hex")}`,
  };

  return {
    credential: w3cCredential,
    sdkEnvelope,
  };
}

/**
 * Sign a per-call agent invocation using the SDK's
 * buildInvocationPreimage + signAgentInvocation. The agent
 * process calls this for every TEE contract invocation to
 * produce the `agent_sig` field in the DelegationEnvelope.
 *
 * Returns the 64-byte compact ECDSA signature over
 * sha256(preimage) - the form the delegation contract accepts.
 */
export function signSdkAgentInvocation(
  vcId: Uint8Array,
  nonce: Uint8Array,
  reqHash: Uint8Array,
  agentPrivateKey: Uint8Array,
): Uint8Array {
  if (vcId.length !== VC_ID_LEN) {
    throw new Error(
      `signSdkAgentInvocation: vcId must be ${VC_ID_LEN} bytes, got ${vcId.length}.`,
    );
  }
  if (nonce.length !== NONCE_LEN) {
    throw new Error(
      `signSdkAgentInvocation: nonce must be ${NONCE_LEN} bytes, got ${nonce.length}.`,
    );
  }
  if (reqHash.length !== REQUEST_HASH_LEN) {
    throw new Error(
      `signSdkAgentInvocation: reqHash must be ${REQUEST_HASH_LEN} bytes, got ${reqHash.length}.`,
    );
  }
  const preimage = buildInvocationPreimage(vcId, nonce, reqHash);
  return signAgentInvocation(preimage, agentPrivateKey);
}

export interface SdkRevokeOptions {
  /** The SDK delegation envelope from mintSdkDelegation. */
  envelope: Pick<SdkDelegationEnvelope, "credentialJcsB64u" | "functions">;
  /**
   * Omit to revoke the whole credential. Pass a subset of
   * function names to revoke only those functions (per-function
   * revocation). The array must be sorted, deduped, and each
   * entry must appear in the credential's functions list.
   */
  revokedFunctions?: string[];
  /** Authenticated T3nClient for the credential's user_did. */
  client: T3nClient;
}

/**
 * Revoke a delegation credential on-chain via the SDK's
 * revokeDelegation (the `tee:delegation/contracts::revoke`
 * entrypoint). Only the credential's `user_did` may call this.
 *
 * When `revokedFunctions` is omitted, the whole credential is
 * revoked. When a subset is supplied, only those functions are
 * revoked (per-function revocation) - e.g. revoke just
 * "settlement-execute" while keeping "seal-intent" live.
 */
export async function revokeSdkDelegation(
  opts: SdkRevokeOptions,
): Promise<RevokeDelegationResult> {
  logger.info(
    {
      event: "sdk_delegation.revoke",
      revokedFunctions: opts.revokedFunctions ?? null,
    },
    "Revoking SDK delegation credential on-chain.",
  );

  return revokeDelegation({
    credentialJcsB64u: opts.envelope.credentialJcsB64u,
    ...(opts.revokedFunctions
      ? { revokedFunctions: opts.revokedFunctions }
      : {}),
    client: opts.client,
  });
}