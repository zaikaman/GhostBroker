import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import {
  buildBackendTestEnv,
  buildHiddenIntentRequest,
  TEST_AUTH_SESSION_SECRET,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";

const services: BackendServices = {
  institutionService: {
    createInstitution: async () => {
      throw new Error("not used");
    },
  },
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
  },
  hiddenIntentService: {
    submitIntent: async () => {
      throw new Error("not used");
    },
    cancelIntent: async () => {
      throw new Error("not used");
    },
    listPendingIntents: () => [],
  },
  portfolioService: {} as never,
  apiKeyService: {} as never,
};

describe("POST /api/agents/intents privacy contract", () => {
  const token = issueOperatorSessionToken({
    secret: TEST_AUTH_SESSION_SECRET,
    did: "did:t3n:operator:us2",
    institutionId: us2InstitutionId,
  });

  it.each(["asset", "side", "quantity", "price"] as const)(
    "rejects plaintext %s fields at the root",
    async (field) => {
      const app = createApp(buildBackendTestEnv(), services);

      const response = await request(app)
        .post("/api/agents/intents")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...buildHiddenIntentRequest(),
          [field]: "SHOULD_NOT_BE_ACCEPTED",
        })
        .expect(400);

      expect(response.body).toEqual({
        code: "validation_failed",
        message: "The request could not be accepted.",
      });
    },
  );

  it.each(["assetCode", "side", "quantity", "price"] as const)(
    "rejects plaintext %s fields nested under any object (no $.settlementMetadata exemption)",
    async (field) => {
      const app = createApp(buildBackendTestEnv(), services);

      // The previous version of the schema exempted
      // `$.settlementMetadata` from the forbidden-fields scan so
      // the agent could pass plaintext asset / side / quantity /
      // price as a sibling of the envelope. The privacy boundary
      // requires the orchestrator to never see plaintext trading
      // parameters; the exemption has been removed. Any attempt
      // to nest forbidden order fields under any object -- even
      // one that looks like the old settlement metadata block --
      // is rejected with 400.
      const response = await request(app)
        .post("/api/agents/intents")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...buildHiddenIntentRequest(),
          settlementMetadata: {
            [field]: "SHOULD_NOT_BE_ACCEPTED",
          },
        })
        .expect(400);

      expect(response.body).toEqual({
        code: "validation_failed",
        message: "The request could not be accepted.",
      });
    },
  );
});
