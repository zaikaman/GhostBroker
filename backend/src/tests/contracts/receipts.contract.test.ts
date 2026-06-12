import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { auditReceiptFromRecord } from "../../models/audit-receipt.js";
import type { AgentAdmissionService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import { ReceiptService } from "../../services/receipt.service.js";
import { buildBackendTestEnv } from "../data/us2-encrypted-intent-builders.js";
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
    } satisfies AgentAdmissionService,
    receiptService,
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

    const response = await request(app)
      .get(`/api/receipts/${us3ReceiptId}`)
      .set("x-operator-institution-id", us3BuyerInstitutionId)
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

    await request(app)
      .get(`/api/receipts/${us3ReceiptId}`)
      .set("x-operator-institution-id", us3UnrelatedInstitutionId)
      .expect(404)
      .expect(({ body }) => {
        expect(body.code).toBe("not_found");
      });
  });
});
