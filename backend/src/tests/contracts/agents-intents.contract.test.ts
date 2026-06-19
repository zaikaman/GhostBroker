import request from "supertest";
import { describe, expect, it } from "vitest";
import { BlindIntentSealFailureError } from "@ghostbroker/t3-enclave";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../../services/hidden-intent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildBackendTestEnv,
  buildHiddenIntentRequest,
  TEST_AUTH_SESSION_SECRET,
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
      secret: TEST_AUTH_SESSION_SECRET,
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

  it("returns 503 sealing_failed with the upstream cause when the T3 enclave refuses to seal (e.g. matching contract not registered)", async () => {
    // The T3 enclave throws a typed BlindIntentSealFailureError when
    // T3N rejects the seal call. The route must NOT swallow it as a
    // generic 400 validation_failed — that hid the real cause from
    // operator logs and the agent. Map it to 503 with a `cause`
    // field that names the real reason.
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new BlindIntentSealFailureError({
            kind: "contract_not_registered",
            status: 404,
            upstreamBody: {
              code: "not_found",
              detail:
                "tenant contract did:t3n:tenant:abc:matching not registered",
            },
            message:
              "T3N tenant contract 'matching' is not registered for this tenant. " +
              "Register the matching contract on T3N, or run the T3 onboarding flow that provisions it automatically.",
          });
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: () => [],
      }),
    );

    const token = issueOperatorSessionToken({
      secret: TEST_AUTH_SESSION_SECRET,
      did: "did:t3n:operator:us2",
      institutionId: us2InstitutionId,
    });

    const response = await request(app)
      .post("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
      .send(buildHiddenIntentRequest())
      .expect(503);

    expect(response.body.code).toBe("sealing_failed");
    expect(response.body.message).toMatch(/sealed by the T3 enclave/i);
    expect(response.body.cause).toMatch(/tenant contract 'matching' is not registered/i);
  });

  it("still maps unrecognized upstream errors to 400 validation_failed so existing tests are not regressed", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("synthetic upstream failure");
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: () => [],
      }),
    );

    const token = issueOperatorSessionToken({
      secret: TEST_AUTH_SESSION_SECRET,
      did: "did:t3n:operator:us2",
      institutionId: us2InstitutionId,
    });

    const response = await request(app)
      .post("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
      .send(buildHiddenIntentRequest())
      .expect(400);

    expect(response.body.code).toBe("validation_failed");
    // validation_failed must NOT leak the cause to the client.
    expect(response.body.cause).toBeUndefined();
  });
});
