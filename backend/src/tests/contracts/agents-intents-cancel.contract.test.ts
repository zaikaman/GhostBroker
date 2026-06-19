import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../../services/hidden-intent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildBackendTestEnv,
  TEST_AUTH_SESSION_SECRET,
  us2AgentDid,
  us2AuthorityRef,
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

describe("POST /api/agents/intents/cancel contract", () => {
  const token = issueOperatorSessionToken({
    secret: TEST_AUTH_SESSION_SECRET,
    did: "did:t3n:operator:us2",
    institutionId: us2InstitutionId,
  });

  it("returns 200 with intent_cancelled state on success", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => ({
          intentHandle: "intent_abc",
          state: "intent_cancelled" as const,
        }),
        listPendingIntents: () => [],
      }),
    );

    const response = await request(app)
      .post("/api/agents/intents/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionId: us2InstitutionId,
        agentDid: us2AgentDid,
        intentHandle: "intent_abc",
        authorityRef: us2AuthorityRef,
      })
      .expect(200);

    expect(response.body).toEqual({
      intentHandle: "intent_abc",
      state: "intent_cancelled",
    });
  });

  it("returns 404 when the service reports no matching intent", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => null,
        listPendingIntents: () => [],
      }),
    );

    await request(app)
      .post("/api/agents/intents/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionId: us2InstitutionId,
        agentDid: us2AgentDid,
        intentHandle: "intent_does_not_exist",
        authorityRef: us2AuthorityRef,
      })
      .expect(404);
  });

  it("returns 400 for malformed body", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: () => [],
      }),
    );

    await request(app)
      .post("/api/agents/intents/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionId: "not-a-uuid",
        agentDid: "also-bad",
        intentHandle: "",
        authorityRef: "x",
      })
      .expect(400);
  });

  it("returns 403 for cross-institution cancel", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => {
          throw new Error("service should not be reached on cross-institution");
        },
        listPendingIntents: () => [],
      }),
    );

    await request(app)
      .post("/api/agents/intents/cancel")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionId: "00000000-0000-4000-8000-000000000999",
        agentDid: us2AgentDid,
        intentHandle: "intent_abc",
        authorityRef: us2AuthorityRef,
      })
      .expect(403);
  });
});
