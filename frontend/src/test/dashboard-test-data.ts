import type { CompletedTrade, AuditReceipt } from '../services/api-client';
import type { TelemetryEvent } from '../services/telemetry-client';

export const mockBuyerInstitutionId = '00000000-0000-4000-8000-000000000301';
export const mockSellerInstitutionId = '00000000-0000-4000-8000-000000000302';
export const mockUnrelatedInstitutionId = '00000000-0000-4000-8000-000000000303';

export const mockReceiptId = '00000000-0000-4000-8000-000000000331';
export const mockCompletedTradeId = '00000000-0000-4000-8000-000000000341';

export function buildMockCompletedTrade(overrides: Partial<CompletedTrade> = {}): CompletedTrade {
  return {
    id: mockCompletedTradeId,
    tradeRef: 'match_outcome_mock',
    assetCodeCiphertext: 't3cipher.asset.mock.ciphertext',
    quantityCiphertext: 't3cipher.quantity.mock.ciphertext',
    executionPriceCiphertext: 't3cipher.execution.mock.ciphertext',
    settledAt: '2026-06-12T00:00:00.000Z',
    settlementStatus: 'settled',
    receiptIds: [mockReceiptId],
    // WS1: rail proof fields. The mock defaults to the
    // chain rail (GhostBroker's only settlement rail).
    railId: 'chain:sepolia:erc20',
    railTradeRef: '0x' + 'a'.repeat(64) as string,
    railState: 'settled',
    ...overrides,
  };
}

export function buildMockAuditReceipt(overrides: Partial<AuditReceipt> = {}): AuditReceipt {
  return {
    id: mockReceiptId,
    completedTradeId: mockCompletedTradeId,
    receiptCiphertext: 't3receipt.mock.ciphertext',
    receiptHash: 'sha256:receipt-mock-hash',
    keyVersion: 'key-v3',
    t3AttestationRef: 't3attest_mock_reference',
    ...overrides,
  };
}

export function buildMockTelemetryEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventId: 'evt_mock_123',
    institutionId: mockBuyerInstitutionId,
    type: 'telemetry.connection.changed',
    phase: 'websocket_connected',
    severity: 'info',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}
