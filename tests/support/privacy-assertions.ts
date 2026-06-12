import { expect, type Page } from '@playwright/test';

export async function assertNoPrivacyLeaks(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  const lowercaseText = bodyText.toLowerCase();

  const forbiddenTerms = [
    'btc',
    'eth',
    'sol',
    'usdt',
    'buy',
    'sell',
  ];

  for (const term of forbiddenTerms) {
    // Check that standard forbidden asset or side labels are completely absent in the rendered UI
    expect(lowercaseText).not.toContain(term);
  }

  // Also check elements containing ciphertext to make sure they don't contain the raw words
  const htmlContent = await page.content();
  const lowercaseHtml = htmlContent.toLowerCase();
  
  // Enforce that active queue listings or labels (like "order queue", "no orders in queue") are redacted/absent
  const forbiddenPatterns = [
    /order queue/i,
    /no active orders/i,
    /no orders in queue/i,
  ];

  for (const pattern of forbiddenPatterns) {
    expect(lowercaseHtml).not.toMatch(pattern);
  }
}
