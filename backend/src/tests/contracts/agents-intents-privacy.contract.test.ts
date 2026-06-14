import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import {
  buildBackendTestEnv,
  buildHiddenIntentRequest,
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
    secret: "development-only-auth-session-secret-change-before-production",
    did: "did:t3n:operator:us2",
    institutionId: us2InstitutionId,
  });

  it.each(["asset", "side", "quantity", "price"] as const)(
    "rejects plaintext %s fields",
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
});
