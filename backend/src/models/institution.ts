import { z } from "zod";

export const institutionStatusSchema = z.enum([
  "pending",
  "active",
  "suspended",
  "closed",
]);

export type InstitutionStatus = z.infer<typeof institutionStatusSchema>;

export const createInstitutionRequestSchema = z.object({
  legalName: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(128),
  settlementProfileRef: z.string().trim().min(1).max(256),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateInstitutionRequest = z.infer<
  typeof createInstitutionRequestSchema
>;

export interface Institution {
  id: string;
  legalName: string;
  displayName: string;
  status: InstitutionStatus;
  t3TenantDid: string;
  settlementProfileRef: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface InstitutionRecord {
  id: string;
  legal_name: string;
  display_name: string;
  status: InstitutionStatus;
  t3_tenant_did: string;
  settlement_profile_ref: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export function institutionFromRecord(record: InstitutionRecord): Institution {
  return {
    id: record.id,
    legalName: record.legal_name,
    displayName: record.display_name,
    status: record.status,
    t3TenantDid: record.t3_tenant_did,
    settlementProfileRef: record.settlement_profile_ref,
    metadata: record.metadata,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}
