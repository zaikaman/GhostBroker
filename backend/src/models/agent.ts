import { z } from "zod";

export const agentDidSchema = z
  .string()
  .trim()
  .min(8)
  .max(256)
  .regex(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/u);

export const admitAgentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  authorityProof: z.string().trim().min(1).max(8192),
});

export type AdmitAgentRequest = z.infer<typeof admitAgentRequestSchema>;

export type AgentAdmissionStatus = "admitted" | "rejected";

export type AgentStatus = "admitted" | "revoked";

export interface AgentAdmission {
  id?: string;
  agentDid: string;
  status: AgentAdmissionStatus;
  authorityRef: string;
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
