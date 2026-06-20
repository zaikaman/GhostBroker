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

/**
 * Server-side W3C VC delegation signer.
 *
 * The institution's tenant identity (a dedicated secp256k1
 * keypair) is the issuer of every delegation credential the
 * backend writes. The institution's separate T3 tenant
 * identity (`did:t3n:0x<addr>` returned by the T3N handshake)
 * is recorded on the institution row for display; it is NOT
 * the VC issuer. The user (the institution's operator) never
 * holds or sees the signing key — it lives in the file-backed
 * identity store at `output/identities/tenant_identity.json`
 * (dev/test fallback) or is loaded from a secret manager via
 * `TENANT_SIGNING_PRIVATE_KEY` (production).
 *
 * IMPORTANT: the tenant signing keypair is a SEPARATE secret
 * from the T3N bearer API key (`T3N_API_KEY`). Conflating the
 * two was the C1 architecture flaw — see
 * `tenant-identity-store.ts` for the full rationale. The
 * `loadOrCreateTenantIdentity` validator rejects any value
 * that is not a canonical 32-byte secp256k1 key, so wiring
 * `T3N_API_KEY` here fails fast at backend boot.
 *
 * This is the production target the plan calls for:
 *
 *   - The user no longer runs `setup:delegation` from a CLI.
 *     The backend mints + signs + persists the VC the moment
 *     the user configures an agent in the dashboard.
 *
 *   - The agent process never sees the VC. The backend
 *     re-verifies the persisted VC on every privileged call
 *     (`/api/agents/admit`, `/api/agents/intents`,
 *     `/api/agents/intents/cancel`, settlement).
 *
 *   - The signer re-uses the canonical browser-safe signer
 *     from `backend/src/sdk/agent-client/delegation-signer.ts`,
 *     so the JWS it produces is byte-identical to the JWS
 *     the legacy CLI produced and the legacy browser-mint UI
 *     produced — `@terminal3/verify_vc`'s `verifyEcdsaVc`
 *     accepts it with no special-casing.
 *
 * The signing body, the canonical-JSON byte layout, the
 * EIP-191 personal_sign prefix, the secp256k1 65-byte JWS,
 * and the `EcdsaSecp256k1Signature2019` proof type are all
 * unchanged. Only the issuer identity moves from "agent"
 * to "institution".
 *
 * The VC's `credentialSubject.allowedActions` is the
 * agent's trading-action scope (the same `RequestedAgentAction`
 * enum the verifier and orchestrator use), not the
 * procurement BUIDL's purchase-category enum. See
 * `t3-enclave/src/auth/ghostbroker-delegation.ts` for the
 * full rationale.
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
  /** The canonical signing body — useful for tests / audit. */
  body: DelegationSigningBody;
}

/**
 * Mint a fresh W3C VC delegation credential signed by the
 * institution's tenant keypair. The returned `credential`
 * is the same shape the legacy CLI / browser-mint produced,
 * so the existing `@terminal3/verify_vc` round-trip in
 * `t3-enclave/src/auth/ghostbroker-delegation.ts` is the
 * unchanged authority gate.
 */
export function mintTenantDelegation(
  policy: TenantDelegationPolicy,
  identity: Pick<TenantIdentity, "did" | "publicKey" | "privateKey" | "address">,
): MintTenantDelegationResult {
  const parsed = tenantDelegationPolicySchema.parse(policy);

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

