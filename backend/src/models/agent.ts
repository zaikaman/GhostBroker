import { z } from "zod";

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
  authorityProof: z.string().trim().min(1).max(8192),
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
