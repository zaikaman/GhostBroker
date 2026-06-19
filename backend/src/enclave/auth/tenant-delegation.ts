import { z } from "zod";
import {
  buildDelegationSigningBody,
  mintDelegationCredentialBody,
  signDelegationCredential,
  type DelegationActionScope,
  type DelegationCredential,
  type DelegationSigningBody,
} from "@ghostbroker/agent-client";
import type { TenantIdentity } from "../sandbox/tenant-identity-store.js";

/**
 * Server-side W3C VC delegation signer.
 *
 * The institution's tenant identity (secp256k1 keypair +
 * `did:t3n:0x...`) is the issuer of every delegation
 * credential the backend writes. The user (the
 * institution's operator) never holds or sees the
 * signing key — it lives in
 * `output/identities/tenant_identity.json`, owned by the
 * backend process.
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
 *     from `@ghostbroker/agent-client/src/delegation-signer.ts`,
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
  identity: Pick<TenantIdentity, "did" | "publicKey" | "privateKey">,
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

  const signed = signDelegationCredential(body, {
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
    issuerDid: identity.did,
  });

  return {
    credential: signed,
    body: buildDelegationSigningBody(body),
  };
}

