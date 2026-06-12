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

export interface AgentAdmission {
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
