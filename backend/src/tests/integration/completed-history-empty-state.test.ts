import { describe, expect, it } from "vitest";
import { TradeHistoryService } from "../../services/trade-history.service.js";
import { us3BuyerInstitutionId } from "../data/us3-settlement-builders.js";

describe("completed history empty response", () => {
  it("returns an empty completed-trade collection without queue metadata", async () => {
    const service = new TradeHistoryService({
      listCompletedTrades: async (institutionId) => {
        expect(institutionId).toBe(us3BuyerInstitutionId);
        return [];
      },
    });

    await expect(
      service.listCompletedTrades(us3BuyerInstitutionId),
    ).resolves.toEqual({ items: [] });
  });
});
