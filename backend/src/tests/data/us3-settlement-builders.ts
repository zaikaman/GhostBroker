import type { AuditReceiptRecord } from "../../models/audit-receipt.js";
import type { CompletedTradeRecord } from "../../models/completed-trade.js";
import type { SettlementExecutionRequest } from "../../services/settlement.service.js";

export const us3BuyerInstitutionId = "00000000-0000-4000-8000-000000000301";
export const us3SellerInstitutionId = "00000000-0000-4000-8000-000000000302";
export const us3UnrelatedInstitutionId = "00000000-0000-4000-8000-000000000303";
export const us3ReceiptId = "00000000-0000-4000-8000-000000000331";
export const us3CompletedTradeId = "00000000-0000-4000-8000-000000000341";

export function buildCompletedTradeRecord(
  overrides: Partial<CompletedTradeRecord> = {},
): CompletedTradeRecord {
  return {
    id: us3CompletedTradeId,
    trade_ref: "match_outcome_us3",
    buy_institution_id: us3BuyerInstitutionId,
    sell_institution_id: us3SellerInstitutionId,
    asset_code_ciphertext: "t3cipher.asset.us3",
    quantity_ciphertext: "t3cipher.quantity.us3",
    execution_price_ciphertext: "t3cipher.execution.us3",
    settlement_status: "settled",
    settled_at: "2026-06-12T00:00:00.000Z",
    t3_execution_ref: "t3exec_us3",
    ...overrides,
  };
}

export function buildAuditReceiptRecord(
  overrides: Partial<AuditReceiptRecord> = {},
): AuditReceiptRecord {
  return {
    id: us3ReceiptId,
    completed_trade_id: us3CompletedTradeId,
    institution_id: us3BuyerInstitutionId,
    receipt_ciphertext: "t3receipt.ciphertext.us3",
    receipt_hash: "sha256:receipt-us3",
    key_version: "key-v3",
    t3_attestation_ref: "t3attest_us3",
    access_scope: "buyer",
    ...overrides,
  };
}

export function buildSettlementExecutionRequest(
  overrides: Partial<SettlementExecutionRequest> = {},
): SettlementExecutionRequest {
  return {
    matchOutcome: {
      outcomeRef: "match_outcome_us3",
      executionRef: "t3exec_us3",
      buyerInstitutionId: us3BuyerInstitutionId,
      sellerInstitutionId: us3SellerInstitutionId,
      encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
      buyerAuthorityRef: "authority:buyer:settle",
      sellerAuthorityRef: "authority:seller:settle",
      // v0.7.0: TEE-attested match attestation binding the
      // recorded institution IDs to the match outcome.
      matchAttestationRef: "match_attest_us3",
      expiresAt: "2026-06-13T00:00:00.000Z",
      status: "matched",
      matchedQuantity: 100,
      executionPrice: 45000,
      buyerLockedAmount: 4_500_000,
      sellerLockedAmount: 100,
    },
    buyerAgentId: "00000000-0000-4000-8000-000000000a01",
    sellerAgentId: "00000000-0000-4000-8000-000000000a02",
    buyerAgentDid: "did:t3n:agent:buyer-us3",
    sellerAgentDid: "did:t3n:agent:seller-us3",
    encryptedTradeFields: {
      assetCodeCiphertext: "t3cipher.asset.us3",
      quantityCiphertext: "t3cipher.quantity.us3",
      executionPriceCiphertext: "t3cipher.execution.us3",
    },
    assetCode: "WBTC",
    quantity: 100,
    executionPrice: 45000,
    receipts: [
      {
        institutionId: us3BuyerInstitutionId,
        receiptCiphertext: "t3receipt.buyer.ciphertext",
        receiptHash: "sha256:buyer-receipt",
        keyVersion: "key-v3",
        t3AttestationRef: "t3attest_buyer",
        accessScope: "buyer",
      },
      {
        institutionId: us3SellerInstitutionId,
        receiptCiphertext: "t3receipt.seller.ciphertext",
        receiptHash: "sha256:seller-receipt",
        keyVersion: "key-v3",
        t3AttestationRef: "t3attest_seller",
        accessScope: "seller",
      },
    ],
    ...overrides,
  };
}
