import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import { auditReceiptFromRecord } from "../../models/audit-receipt.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import { ReceiptService } from "../../services/receipt.service.js";
import {
  buildBackendTestEnv,
  TEST_AUTH_SESSION_SECRET,
} from "../data/us2-encrypted-intent-builders.js";
import {
  buildAuditReceiptRecord,
  us3BuyerInstitutionId,
  us3ReceiptId,
  us3UnrelatedInstitutionId,
} from "../data/us3-settlement-builders.js";

function buildServices(receiptService: ReceiptService): BackendServices {
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
    receiptService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
  };
}

describe("GET /api/receipts/:receiptId contract", () => {
  it("returns encrypted receipt data for the authorized institution", async () => {
    const receipt = auditReceiptFromRecord(buildAuditReceiptRecord());
    const app = createApp(
      buildBackendTestEnv(),
      buildServices(
        new ReceiptService({
          getAuthorizedReceipt: async (receiptId, institutionId) => {
            expect(receiptId).toBe(us3ReceiptId);
            expect(institutionId).toBe(us3BuyerInstitutionId);
            return receipt;
          },
          markOpened: async () => undefined,
        }),
      ),
    );

    const buyerToken = issueOperatorSessionToken({
      secret: TEST_AUTH_SESSION_SECRET,
      did: "did:t3n:operator:us3-buyer",
      institutionId: us3BuyerInstitutionId,
    });

    const response = await request(app)
      .get(`/api/receipts/${us3ReceiptId}`)
      .set("Authorization", `Bearer ${buyerToken}`)
      .expect(200);

    expect(response.body).toEqual(receipt);
  });

  it("returns a redacted not_found response for unrelated institutions", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices(
        new ReceiptService({
          getAuthorizedReceipt: async () => null,
          markOpened: async () => undefined,
        }),
      ),
    );

    const unrelatedToken = issueOperatorSessionToken({
      secret: TEST_AUTH_SESSION_SECRET,
      did: "did:t3n:operator:us3-unrelated",
      institutionId: us3UnrelatedInstitutionId,
    });

    await request(app)
      .get(`/api/receipts/${us3ReceiptId}`)
      .set("Authorization", `Bearer ${unrelatedToken}`)
      .expect(404)
      .expect(({ body }) => {
        expect(body.code).toBe("not_found");
      });
  });
});
