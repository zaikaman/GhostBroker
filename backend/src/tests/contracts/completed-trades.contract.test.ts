import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AgentAdmissionService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import { TradeHistoryService } from "../../services/trade-history.service.js";
import {
  buildCompletedTradeRecord,
  us3BuyerInstitutionId,
} from "../data/us3-settlement-builders.js";
import { buildBackendTestEnv } from "../data/us2-encrypted-intent-builders.js";
import { completedTradeFromRecord } from "../../models/completed-trade.js";

function buildServices(tradeHistoryService: TradeHistoryService): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => {
        throw new Error("not used");
      },
    } satisfies InstitutionManagementService,
    agentService: {
      admitAgent: async () => {
        throw new Error("not used");
      },
    } satisfies AgentAdmissionService,
    tradeHistoryService,
  };
}

describe("GET /api/trades/completed contract", () => {
  it("returns scoped completed trade records with encrypted fields", async () => {
    const trade = completedTradeFromRecord(buildCompletedTradeRecord(), [
      "00000000-0000-4000-8000-000000000331",
    ]);
    const app = createApp(
      buildBackendTestEnv(),
      buildServices(
        new TradeHistoryService({
          listCompletedTrades: async (institutionId) => {
            expect(institutionId).toBe(us3BuyerInstitutionId);
            return [trade];
          },
        }),
      ),
    );

    const response = await request(app)
      .get("/api/trades/completed")
      .set("x-operator-institution-id", us3BuyerInstitutionId)
      .expect(200);

    expect(response.body).toEqual({ items: [trade] });
    expect(JSON.stringify(response.body)).not.toMatch(
      /"asset"|"side"|"quantity"|"price"|"counterparty"|queue/iu,
    );
  });
});
