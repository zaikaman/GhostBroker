import { z } from "zod";

export const receiptIdParamSchema = z.object({
  receiptId: z.string().uuid(),
});

export const accessScopeSchema = z.enum(["buyer", "seller", "regulatory_export"]);
export type AuditReceiptAccessScope = z.infer<typeof accessScopeSchema>;

export interface AuditReceipt {
  id: string;
  completedTradeId: string;
  receiptCiphertext: string;
  receiptHash: string;
  keyVersion: string;
  t3AttestationRef: string;
}

export interface AuditReceiptRecord {
  id: string;
  completed_trade_id: string;
  institution_id: string;
  receipt_ciphertext: string;
  receipt_hash: string;
  key_version: string;
  t3_attestation_ref: string;
  access_scope: AuditReceiptAccessScope;
  created_at?: string;
  opened_at?: string | null;
}

export function auditReceiptFromRecord(record: AuditReceiptRecord): AuditReceipt {
  return {
    id: record.id,
    completedTradeId: record.completed_trade_id,
    receiptCiphertext: record.receipt_ciphertext,
    receiptHash: record.receipt_hash,
    keyVersion: record.key_version,
    t3AttestationRef: record.t3_attestation_ref,
  };
}
