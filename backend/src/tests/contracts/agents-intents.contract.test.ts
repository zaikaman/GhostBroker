import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
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
      listAgents: async () => { throw new Error("not used"); },
      getAgent: async () => { throw new Error("not used"); },
      updateAgentLabel: async () => { throw new Error("not used"); },
      revokeAgent: async () => { throw new Error("not used"); },
      persistDelegation: async () => { throw new Error("not used"); },
      loadDelegationCredential: async () => null,
        configureAgent: async () => { throw new Error("not used"); },
    } as AgentManagementService,
    hiddenIntentService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
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
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: () => [],
      }),
    );

    const token = issueOperatorSessionToken({
      secret: "development-only-auth-session-secret-change-before-production",
      did: "did:t3n:operator:us2",
      institutionId: us2InstitutionId,
    });

    const response = await request(app)
      .post("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
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
