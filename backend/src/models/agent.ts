import { z } from "zod";
import { negotiationMandateSchema } from "./negotiation.js";

export const agentDidSchema = z
  .string()
  .trim()
  .min(8)
  .max(256)
  .regex(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/u);

export const authorityLimitsSchema = z.object({
  instrumentScope: z.array(z.string().min(1)).min(1).optional(),
  directionScope: z.array(z.enum(["buy", "sell"])).min(1).optional(),
  maxNotional: z.string().regex(/^\d+$/u).optional(),
  limitReference: z.string().min(1).optional(),
  policyHash: z.string().min(1).optional(),
});

export const admitAgentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  /**
   * Ghostbroker-style W3C Verifiable Credential. The backend runs
   * this through `t3-enclave/src/auth/ghostbroker-delegation.ts`
   * to verify the agent is authorized for this institution.
   * The credential is persisted on the agent record at admit
   * time so the intent submit / cancel / settlement paths can
   * re-verify it on every privileged action.
   */
  delegationCredential: z.unknown().optional(),
  limits: authorityLimitsSchema.optional(),
});

export type AdmitAgentRequest = z.infer<typeof admitAgentRequestSchema>;

export type AgentAdmissionStatus = "admitted" | "rejected";

/**
 * Trading direction scope: which sides an agent is authorized to trade.
 */
export type DirectionScope = "buy" | "sell";

export type AgentStatus = "admitted" | "revoked";

/**
 * Trading limits embedded in the authority claim.
 */
export interface AgentAuthorityLimits {
  instrumentScope: string[];
  directionScope: DirectionScope[];
  maxNotional: string;
  limitReference: string;
  policyHash: string;
}

export interface AgentAdmission {
  id?: string;
  agentDid: string;
  status: AgentAdmissionStatus;
  authorityRef: string;
  limits?: AgentAuthorityLimits;
}

export interface AgentAdmissionDecision {
  admitted: boolean;
  agentDid: string;
  authorityRef?: string;
  rejectionCode?: "expired" | "revoked" | "over_scoped" | "unverified";
}

// ── DB Record Types ─────────────────────────────────────────────────────

export interface AgentRecord {
  id: string;
  institution_id: string;
  agent_did: string;
  status: AgentStatus;
  authority_ref: string;
  label: string | null;
  instrument_scope: string[] | null;
  direction_scope: string[] | null;
  max_notional: string | null;
  limit_reference: string | null;
  policy_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  institutionId: string;
  agentDid: string;
  status: AgentStatus;
  authorityRef: string;
  label: string | null;
  instrumentScope: string[] | null;
  directionScope: string[] | null;
  maxNotional: string | null;
  limitReference: string | null;
  policyHash: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export function agentFromRecord(record: AgentRecord): Agent {
  return {
    id: record.id,
    institutionId: record.institution_id,
    agentDid: record.agent_did,
    status: record.status,
    authorityRef: record.authority_ref,
    label: record.label,
    instrumentScope: record.instrument_scope ?? null,
    directionScope: record.direction_scope ?? null,
    maxNotional: record.max_notional ?? null,
    limitReference: record.limit_reference ?? null,
    policyHash: record.policy_hash ?? null,
    metadata: record.metadata,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

// ── API Schemas ─────────────────────────────────────────────────────────

export const listAgentsQuerySchema = z.object({
  status: z.enum(["admitted", "revoked"]).optional(),
});

export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

export const revokeAgentParamsSchema = z.object({
  id: z.string().uuid(),
});

export type RevokeAgentParams = z.infer<typeof revokeAgentParamsSchema>;

export const updateAgentLabelSchema = z.object({
  label: z.string().trim().min(1).max(100),
});

export type UpdateAgentLabelBody = z.infer<typeof updateAgentLabelSchema>;

// ── Phase 1: server-minted delegation policy ──────────────────────────

/**
 * The policy knobs the dashboard's "Configure Agent" form
 * collects. All fields are bounded so a malformed UI can't
 * mint a runaway VC. The backend signs the VC with the
 * institution's tenant keypair — the user never holds or
 * sees the signing key.
 *
 * The `allowedActions` field is the trading-agent action
 * scope (the same `RequestedAgentAction` enum the verifier
 * and orchestrator use), not the procurement BUIDL's
 * purchase-category enum. See
 * `t3-enclave/src/auth/ghostbroker-delegation.ts` for the
 * full rationale.
 */
export const mintDelegationPolicySchema = z.object({
  maxSpendUsd: z.number().positive().max(1_000_000_000),
  allowedActions: z
    .array(
      z.enum([
        "agent.admit",
        "intent.submit",
        "settlement.execute",
        "negotiation.open",
        "negotiation.move",
        "negotiation.disclose",
        "negotiation.settle",
      ]),
    )
    .min(1)
    .max(20),
  approverEmail: z.string().email().optional(),
  purpose: z.string().trim().min(1).max(500).optional(),
  mandate: negotiationMandateSchema.optional(),
  validityMonths: z.number().int().positive().max(120).optional(),
});

export type MintDelegationPolicy = z.infer<typeof mintDelegationPolicySchema>;

export const mintDelegationParamsSchema = z.object({
  id: z.string().uuid(),
});

export const mintDelegationResponseSchema = z.object({
  authorityRef: z.string().min(1),
  policyHash: z.string().min(1),
});

/**
 * Phase 2.5 + Phase 1 step 4: "Configure Agent" entrypoint.
 *
 * The dashboard's "Deploy Agent" form posts this body;
 * the Phase 2.5 demo orchestrator posts it for each side
 * (buyer + seller) before spawning the child processes.
 * The backend:
 *
 *   1. Mints a placeholder agent DID (the agent process
 *      later sends the same DID on admit; we don't yet
 *      know what the agent will choose, so we default
 *      to `did:t3n:demo-<random>` for the demo path and
 *      accept an explicit `agentDid` from the dashboard).
 *   2. Mints a fresh tenant delegation VC for that
 *      DID using the institution's tenant keypair.
 *   3. Persists the agent record with the VC in
 *      `metadata.delegation_credential`.
 *   4. Returns `{ agentId, agentDid, authorityRef,
 *      policyHash }` so the caller (dashboard or
 *      orchestrator) can pass `agentId` to the
 *      `loadAndVerify` facade on the next admit /
 *      intent call.
 */
export const configureAgentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  /**
   * The secp256k1-derived agent DID the dashboard minted in the
   * browser (`did:t3n:0x<eth-address>`). Required: the backend
   * binds the tenant-signed delegation VC to this DID, so the
   * dashboard (which holds the matching private keypair) is the
   * authoritative source of agent identity. A backend-minted
   * placeholder DID would let any caller mint + sign an admission
   * without holding a keypair, so it has been removed.
   */
  agentDid: agentDidSchema,
  label: z.string().trim().min(1).max(100).optional(),
  policy: mintDelegationPolicySchema,
});

export type ConfigureAgentRequest = z.infer<typeof configureAgentRequestSchema>;

export interface ConfigureAgentResponse {
  agentId: string;
  agentDid: string;
  authorityRef: string;
  policyHash: string;
}

export const provisionAgentResponseSchema = z.object({
  agent: z.object({
    id: z.string().uuid(),
    institutionId: z.string().uuid(),
    agentDid: z.string().min(1),
    status: z.enum(["admitted", "revoked"]),
    authorityRef: z.string().min(1),
    label: z.string().nullable(),
    instrumentScope: z.array(z.string()).nullable(),
    directionScope: z.array(z.string()).nullable(),
    maxNotional: z.string().nullable(),
    limitReference: z.string().nullable(),
    policyHash: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  admission: z.object({
    id: z.string().uuid().optional(),
    agentDid: z.string().min(1),
    status: z.literal("admitted"),
    authorityRef: z.string().min(1),
  }),
  policyHash: z.string().min(1),
});

export type ProvisionAgentResponse = z.infer<typeof provisionAgentResponseSchema>;
