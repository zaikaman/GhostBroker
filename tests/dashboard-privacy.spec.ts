import { test, expect } from '@playwright/test';
import { 
  clearDatabase, 
  seedInstitutions, 
  seedCompletedTradeAndReceipt,
  us3UnrelatedInstitutionId,
  us3BuyerInstitutionId,
  us3ReceiptId
} from './support/local-stack';
import { assertNoPrivacyLeaks } from './support/privacy-assertions';

const API_BASE_URL = process.env.PLAYWRIGHT_API_BASE_URL || 'http://localhost:3001';

async function setAuthContext(page: any, pwRequest: any, institutionId: string, operatorId: string) {
  const tokenRes = await pwRequest.post(`${API_BASE_URL}/api/dev/token`, {
    data: { institutionId },
  });
  const { token } = await tokenRes.json();
  await page.evaluate(({ instId, opId, authToken }) => {
    localStorage.setItem('x-operator-institution-id', instId);
    localStorage.setItem('x-operator-id', opId);
    localStorage.setItem('ghostbroker-auth-token', authToken);
  }, { instId: institutionId, opId: operatorId, authToken: token });
}

test.describe('Dashboard Privacy Guardrails', () => {
  test.beforeEach(async ({ page }) => {
    // Reset and seed database
    await clearDatabase();
    await seedInstitutions();
    await seedCompletedTradeAndReceipt();
  });

  test('should hide trades from unrelated institution and prevent privacy leaks', async ({ page, request: pwRequest }) => {
    // Set operator to Unrelated Institution
    await page.goto('/');
    await setAuthContext(page, pwRequest, us3UnrelatedInstitutionId, 'operator:e2e-unrelated');

    await page.reload();

    // Verify empty state is shown (since the trade is only for buyer & seller)
    await expect(page.locator('text=No completed trades recorded')).toBeVisible();
    await expect(page.locator('text=match_outcome_us3')).not.toBeVisible();

    // Verify no privacy leaks of active order terms or plaintext properties
    await assertNoPrivacyLeaks(page);
  });

  test('should deny receipt decryption for unrelated institution and render safe error', async ({ page, request: pwRequest }) => {
    // 1. Authenticate as Buyer first to open the receipt drawer
    await page.goto('/');
    await setAuthContext(page, pwRequest, us3BuyerInstitutionId, 'operator:e2e-buyer');
    await page.reload();

    // Open receipt drawer
    const auditBtn = page.locator('button:has-text("Audit Receipt")');
    await expect(auditBtn).toBeVisible();
    await auditBtn.dispatchEvent('click');
    await expect(page.getByTestId('receipt-drawer')).toBeVisible();

    // 2. Change operator context in localStorage to unrelated institution
    await setAuthContext(page, pwRequest, us3UnrelatedInstitutionId, 'operator:e2e-unrelated');

    // 3. Directly load/request the receipt endpoint as the unrelated operator
    // Since the drawer is open, a reload will trigger a fetch using the new credentials
    await page.reload();

    // Drawer should show the secure decryption authorization error
    await expect(page.locator('text=Decryption Authorization Failed')).toBeVisible();
    await expect(page.locator('text=Verification failed. The operator does not hold keys to decrypt this receipt.')).toBeVisible();
    await expect(page.locator('text=t3receipt.buyer.ciphertext')).not.toBeVisible();

    // Double check privacy leaks
    await assertNoPrivacyLeaks(page);
  });
});
