import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
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
  },
  hiddenIntentService: {
    submitIntent: async () => {
      throw new Error("plaintext request should not reach service");
    },
  },
};

describe("POST /api/agents/intents privacy contract", () => {
  it.each(["asset", "side", "quantity", "price"] as const)(
    "rejects plaintext %s fields",
    async (field) => {
      const app = createApp(buildBackendTestEnv(), services);

      const response = await request(app)
        .post("/api/agents/intents")
        .set("x-operator-institution-id", us2InstitutionId)
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
