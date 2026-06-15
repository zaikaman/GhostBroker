import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
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
      listAgents: async () => { throw new Error("not used"); },
      getAgent: async () => { throw new Error("not used"); },
      updateAgentLabel: async () => { throw new Error("not used"); },
      revokeAgent: async () => { throw new Error("not used"); },
      persistDelegation: async () => { throw new Error("not used"); },
      loadDelegationCredential: async () => null,
        configureAgent: async () => { throw new Error("not used"); },
    } as AgentManagementService,
    tradeHistoryService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
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

    const token = issueOperatorSessionToken({
      secret: "development-only-auth-session-secret-change-before-production",
      did: "did:t3n:operator:us3",
      institutionId: us3BuyerInstitutionId,
    });

    const response = await request(app)
      .get("/api/trades/completed")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ items: [trade] });
    expect(JSON.stringify(response.body)).not.toMatch(
      /"asset"|"side"|"quantity"|"price"|"counterparty"|queue/iu,
    );
  });
});
