import { describe, expect, it } from "vitest";
import { ReceiptService } from "../../services/receipt.service.js";
import { us3BuyerInstitutionId, us3ReceiptId } from "../data/us3-settlement-builders.js";

describe("receipt access audit", () => {
  it("updates opened_at after an authorized encrypted receipt read", async () => {
    const openedAtValues: string[] = [];
    const service = new ReceiptService({
      getAuthorizedReceipt: async () => ({
        id: us3ReceiptId,
        completedTradeId: "00000000-0000-4000-8000-000000000341",
        institutionId: us3BuyerInstitutionId,
        receiptCiphertext: "t3receipt.ciphertext.us4",
        receiptHash: "sha256:receipt-us4",
        keyVersion: "key-v4",
        t3AttestationRef: "t3attest_us4",
        accessScope: "buyer",
        openedAt: undefined,
      }),
      markOpened: async (receiptId, institutionId, openedAt) => {
        expect(receiptId).toBe(us3ReceiptId);
        expect(institutionId).toBe(us3BuyerInstitutionId);
        openedAtValues.push(openedAt);
      },
    });

    await expect(
      service.getReceipt(us3ReceiptId, us3BuyerInstitutionId),
    ).resolves.toMatchObject({
      receiptHash: "sha256:receipt-us4",
    });
    expect(openedAtValues).toHaveLength(1);
    expect(new Date(openedAtValues[0] ?? Number.NaN).toISOString()).toBe(
      openedAtValues[0],
    );
  });
});
