import { test, expect } from '@playwright/test';
import { 
  clearDatabase, 
  seedInstitutions, 
  seedCompletedTradeAndReceipt,
  us3BuyerInstitutionId
} from './support/local-stack';

const API_BASE_URL = process.env.PLAYWRIGHT_API_BASE_URL || 'http://localhost:3001';

test.describe('Operator Dashboard E2E Workflow', () => {
  test.beforeEach(async ({ page, request: pwRequest }) => {
    // Reset and seed the database
    await clearDatabase();
    await seedInstitutions();
    await seedCompletedTradeAndReceipt();

    // Get a real session token from the dev endpoint
    const tokenRes = await pwRequest.post(`${API_BASE_URL}/api/dev/token`, {
      data: { institutionId: us3BuyerInstitutionId },
    });
    const { token } = await tokenRes.json();

    // Set operator context and auth token in localStorage
    await page.goto('/');
    await page.evaluate(({ instId, authToken }) => {
      localStorage.setItem('x-operator-institution-id', instId);
      localStorage.setItem('x-operator-id', 'operator:e2e-buyer');
      localStorage.setItem('ghostbroker-auth-token', authToken);
    }, { instId: us3BuyerInstitutionId, authToken: token });
    
    // Reload to apply the local storage auth
    await page.reload();
  });

  test('should display secure status metrics and trade history with encryption', async ({ page }) => {
    // 1. Verify Connection Status Metrics
    const enclaveStatus = page.locator('text=TEE Enclave Status');
    await expect(enclaveStatus).toBeVisible();
    await expect(page.locator('.status-badge.secure', { hasText: /^SECURE$/ })).toBeVisible();

    // 2. Verify Trade History is populated and fields are truncated/encrypted
    await expect(page.locator('text=match_outcome_us3')).toBeVisible();
    
    // Check that asset and other fields are encrypted and truncated
    await expect(page.locator('text=t3cipher.as...sealed')).toBeVisible();
    await expect(page.locator('text=t3cipher.qu...sealed')).toBeVisible();
    await expect(page.locator('text=t3cipher.ex...sealed')).toBeVisible();
    await expect(page.locator('.status-badge.secure', { hasText: /^settled$/ })).toBeVisible();
  });

  test('should open audit receipt drawer and decrypt audit details', async ({ page }) => {
    // 1. Open the drawer by clicking Audit Receipt
    const auditBtn = page.locator('button:has-text("Audit Receipt")');
    await expect(auditBtn).toBeVisible();
    await auditBtn.dispatchEvent('click');

    // 2. Assert drawer contents
    const drawer = page.getByTestId('receipt-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.locator('text=Cryptographic Audit Receipt')).toBeVisible();
    
    // Attestation reference and key version check
    await expect(page.locator('text=t3attest_buyer_verification_attestation_proof')).toBeVisible();
    await expect(page.locator('text=key-v3')).toBeVisible();
    await expect(page.locator('text=sha256:buyer-receipt-audit-hash-code-verification-reference')).toBeVisible();
    await expect(page.locator('text=t3receipt.buyer.ciphertext_payload_envelope_contents_sealed_in_tee_enclave')).toBeVisible();

    // 3. Close drawer
    const closeBtn = page.locator('button:has-text("Acknowledge & Close")');
    await closeBtn.dispatchEvent('click');
    await expect(drawer).not.toBeVisible();
  });
});
