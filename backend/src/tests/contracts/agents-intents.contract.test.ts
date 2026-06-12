import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AgentAdmissionService } from "../../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../../services/hidden-intent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildBackendTestEnv,
  buildHiddenIntentRequest,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";

function buildServices(
  hiddenIntentService: HiddenIntentSubmissionService,
): BackendServices {
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
    hiddenIntentService,
  };
}

describe("POST /api/agents/intents contract", () => {
  it("accepts encrypted intent envelopes and returns only opaque state", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => ({
          intentHandle: "intent_opaque_us2",
          state: "intent_sealed",
        }),
      }),
    );

    const response = await request(app)
      .post("/api/agents/intents")
      .set("x-operator-institution-id", us2InstitutionId)
      .send(buildHiddenIntentRequest())
      .expect(202);

    expect(response.body).toEqual({
      intentHandle: "intent_opaque_us2",
      state: "intent_sealed",
    });
    expect(Object.keys(response.body).sort()).toEqual(
      ["intentHandle", "state"].sort(),
    );
  });
});
