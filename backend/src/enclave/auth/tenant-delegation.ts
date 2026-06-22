import { z } from "zod";
import {
  buildDelegationSigningBody,
  mintDelegationCredentialBody,
  signDelegationCredential,
  type DelegationActionScope,
  type DelegationCredential,
  type DelegationSigningBody,
} from "../../sdk/agent-client/index.js";
import type { TenantIdentity } from "../sandbox/tenant-identity-store.js";
import {
  mintSdkDelegation,
  type SdkDelegationEnvelope,
  type SdkMintResult,
} from "./sdk-delegation-signer.js";
import { logger } from "../../logging/logger.js";

/**
 * Server-side W3C VC delegation signer.
 *
 * The institution's tenant identity (a dedicated secp256k1
 * keypair) is the issuer of every delegation credential the
 * backend writes. The institution's separate T3 tenant
 * identity (`did:t3n:0x<addr>` returned by the T3N handshake)
 * is recorded on the institution row for display; it is NOT
 * the VC issuer. The user (the institution's operator) never
 * holds or sees the signing key - it lives in the file-backed
 * identity store at `output/identities/tenant_identity.json`
 * (dev/test fallback) or is loaded from a secret manager via
 * `TENANT_SIGNING_PRIVATE_KEY` (production).
 *
 * IMPORTANT: the tenant signing keypair is a SEPARATE secret
 * from the T3N bearer API key (`T3N_API_KEY`). Conflating the
 * two was the C1 architecture flaw - see
 * `tenant-identity-store.ts` for the full rationale. The
 * `loadOrCreateTenantIdentity` validator rejects any value
 * that is not a canonical 32-byte secp256k1 key, so wiring
 * `T3N_API_KEY` here fails fast at backend boot.
 *
 * ## SDK-native minting path (default)
 *
 * As of t3n-sdk v3.9.0, the backend uses the SDK's native
 * delegation lifecycle primitives (`buildDelegationCredential`,
 * `canonicaliseCredential`, `signCredential`) as the default
 * minting path. The SDK-native credential is used for on-chain
 * revocation via `revokeDelegation` and for per-call agent
 * invocation signatures via `signAgentInvocation`.
 *
 * The SDK-native path also produces a W3C VC (via the existing
 * signer) so the current `@terminal3/verify_vc`-backed verifier
 * in `ghostbroker-delegation.ts` continues to work unchanged.
 * The migration is about the minting/signing side, not the
 * verify side.
 *
 * ## Legacy fallback
 *
 * If the SDK-native path throws (e.g. the SDK delegation
 * contract is not provisioned in the current environment), the
 * signer falls back to the custom `delegation-signer.ts` path.
 * The legacy path produces only the W3C VC (no SDK envelope),
 * so on-chain revocation is not available for credentials
 * minted via the fallback.
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

export const tenantDelegationPolicySchema = z.object({
  agentDid: z.string().min(1),
  institutionId: z.string().min(1),
  maxSpendUsd: z.number().positive(),
  allowedActions: z.array(delegationActionScopeSchema).min(1),
  approverEmail: z.string().email().optional(),
  purpose: z.string().min(1).optional(),
  validityMonths: z.number().int().positive().max(120).optional(),
});

export type TenantDelegationPolicy = z.infer<typeof tenantDelegationPolicySchema>;

export interface MintTenantDelegationResult {
  /** The signed W3C VC, ready to persist on the agent record. */
  credential: DelegationCredential;
  /** The canonical signing body - useful for tests / audit. */
  body: DelegationSigningBody;
  /**
   * The SDK-native delegation envelope (JCS bytes + EIP-191
   * signature + agent invocation keypair) for on-chain
   * revocation via `revokeDelegation` and per-call invocation
   * signing via `signAgentInvocation`. Absent when the legacy
   * fallback path was used.
   */
  sdkEnvelope?: SdkDelegationEnvelope;
}

/**
 * Mint a fresh delegation credential signed by the
 * institution's tenant keypair. The returned `credential`
 * is the W3C VC shape the existing `@terminal3/verify_vc`
 * verifier in `ghostbroker-delegation.ts` cryptographically
 * verifies on every privileged call.
 *
 * The SDK-native path (`mintSdkDelegation`) is the default;
 * it also produces an `sdkEnvelope` carrying the JCS-
 * canonicalised credential bytes and EIP-191 signature for
 * on-chain revocation. If the SDK path throws, the legacy
 * custom signer path is used as a fallback (no SDK envelope).
 */
export function mintTenantDelegation(
  policy: TenantDelegationPolicy,
  identity: Pick<TenantIdentity, "did" | "publicKey" | "privateKey" | "address">,
): MintTenantDelegationResult {
  const parsed = tenantDelegationPolicySchema.parse(policy);

  // Try the SDK-native path first (default).
  try {
    const sdkResult: SdkMintResult = mintSdkDelegation(
      {
        agentDid: parsed.agentDid,
        institutionId: parsed.institutionId,
        maxSpendUsd: parsed.maxSpendUsd,
        allowedActions: [...parsed.allowedActions] as DelegationActionScope[],
        ...(parsed.approverEmail ? { approverEmail: parsed.approverEmail } : {}),
        ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
        ...(parsed.validityMonths ? { validityMonths: parsed.validityMonths } : {}),
      },
      identity,
    );
    return {
      credential: sdkResult.credential,
      body: buildDelegationSigningBody(sdkResult.credential),
      sdkEnvelope: sdkResult.sdkEnvelope,
    };
  } catch (error) {
    // SDK-native path failed (e.g. SDK delegation contract not
    // provisioned, or a validation error from the SDK). Fall
    // back to the legacy custom signer path, which produces
    // only the W3C VC without the SDK envelope.
    logger.warn(
      {
        event: "tenant_delegation.sdk_path_failed",
        err: error instanceof Error ? error.message : String(error),
      },
      "SDK-native delegation path failed; falling back to legacy signer.",
    );
  }

  // Legacy fallback: custom W3C VC signer.
  return mintLegacyDelegation(parsed, identity);
}

/**
 * Legacy custom W3C VC signer path. Produces only the W3C VC
 * (no SDK envelope). Used as a fallback when the SDK-native
 * path is unavailable.
 */
function mintLegacyDelegation(
  parsed: TenantDelegationPolicy,
  identity: Pick<TenantIdentity, "did" | "publicKey" | "privateKey" | "address">,
): MintTenantDelegationResult {
  const body = mintDelegationCredentialBody({
    agentDid: parsed.agentDid,
    issuerDid: identity.did,
    maxSpendUsd: parsed.maxSpendUsd,
    allowedActions: [...parsed.allowedActions] as DelegationActionScope[],
    ...(parsed.approverEmail ? { approverEmail: parsed.approverEmail } : {}),
    ...(parsed.purpose ? { purpose: parsed.purpose } : {}),
    ...(parsed.validityMonths ? { validityMonths: parsed.validityMonths } : {}),
  });

  // Embed the signing keypair's address as an additional
  // `verificationMethod` entry when it differs from the
  // `issuerDid`'s embedded address. Production server-minted
  // VCs derive the issuer DID from the keypair (so the two
  // addresses match and the SDK path succeeds directly);
  // this branch fires for hand-crafted VCs that pre-set a
  // different `issuerDid` (e.g. legacy `did:t3n:0x<addr>`
  // issuers the verifier normalizes on the read side).
  const didAddress = identity.did.toLowerCase().match(/0x[0-9a-f]{40}/u)?.[0];
  const includeExtraSigner = didAddress !== identity.address.toLowerCase();

  const signed = signDelegationCredential(body, {
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
    issuerDid: identity.did,
    ...(includeExtraSigner
      ? {
          additionalSignerVerificationMethod: `did:ethr:${identity.address}#controller`,
        }
      : {}),
  });

  return {
    credential: signed,
    body: buildDelegationSigningBody(body),
  };
}