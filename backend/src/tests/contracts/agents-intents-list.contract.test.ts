import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../../services/hidden-intent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import type { PendingIntent } from "../../models/hidden-intent.js";
import {
  buildBackendTestEnv,
  TEST_AUTH_SESSION_SECRET,
  us2AgentDid,
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

const sampleIntent: PendingIntent = {
  correlationRef: "corr_list_1",
  institutionId: us2InstitutionId,
  agentDid: us2AgentDid,
  intentHandle: "intent_list_1",
  executionRef: "t3exec_list_1",
  // Private fields -- these must NOT appear in the response.
  encryptedEnvelope: "t3env.ciphertext.secret",
  authorityRef: "authority:secret",
  delegationCredential: { id: "vc-list-1", issuer: "did:t3n:list" },
  opaqueLockDescriptor: {
    tradedAssetCode: "WBTC",
    assetCode: "USDC",
    side: "buy",
    amount: 4_500_000,
    attestationRef: "t3attest:list_1",
  },
  sealedAt: "2026-06-12T00:00:00.000Z",
  instrumentScope: ["WBTC"],
  directionScope: ["buy", "sell"],
  maxNotional: "1000000",
};

describe("GET /api/agents/intents contract", () => {
  const token = issueOperatorSessionToken({
    secret: TEST_AUTH_SESSION_SECRET,
    did: "did:t3n:operator:us2",
    institutionId: us2InstitutionId,
  });

  it("returns the list of pending intents as a stripped view", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: () => [sampleIntent],
      }),
    );

    const response = await request(app)
      .get("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // The orchestrator no longer holds plaintext asset / side /
    // quantity / price in memory; the public view is the opaque
    // intent handle + correlation ref + agent DID + sealed-at
    // timestamp. Active order parameters are held only inside
    // the TEE.
    expect(response.body).toEqual({
      intents: [
        {
          intentHandle: "intent_list_1",
          correlationRef: "corr_list_1",
          agentDid: us2AgentDid,
          sealedAt: "2026-06-12T00:00:00.000Z",
        },
      ],
    });
  });

  it("does not leak encrypted envelope, authority ref, authority limits, or the lock descriptor", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: () => [sampleIntent],
      }),
    );

    const response = await request(app)
      .get("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("t3env.ciphertext.secret");
    expect(serialized).not.toContain("authority:secret");
    expect(serialized).not.toContain("instrumentScope");
    expect(serialized).not.toContain("directionScope");
    expect(serialized).not.toContain("maxNotional");
    expect(serialized).not.toContain("executionRef");
    expect(serialized).not.toContain("encryptedEnvelope");
    expect(serialized).not.toContain("opaqueLockDescriptor");
    expect(serialized).not.toContain("attestationRef");
    expect(serialized).not.toContain("delegationCredential");
  });

  it("returns an empty list when there are no pending intents", async () => {
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

    const response = await request(app)
      .get("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ intents: [] });
  });

  it("forwards the agentDid filter to the service", async () => {
    const received: { institutionId: string; agentDid?: string }[] = [];
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: (params) => {
          received.push(params);
          return [];
        },
      }),
    );

    await request(app)
      .get(`/api/agents/intents?agentDid=${encodeURIComponent(us2AgentDid)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(received).toEqual([
      { institutionId: us2InstitutionId, agentDid: us2AgentDid },
    ]);
  });

  it("returns 400 for a malformed agentDid query parameter", async () => {
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
      .get("/api/agents/intents?agentDid=not-a-did")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });

  it("scopes the list to the authenticated institution only", async () => {
    const received: { institutionId: string }[] = [];
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        submitIntent: async () => {
          throw new Error("not used");
        },
        cancelIntent: async () => {
          throw new Error("not used");
        },
        listPendingIntents: (params) => {
          received.push({ institutionId: params.institutionId });
          return [];
        },
      }),
    );

    await request(app)
      .get("/api/agents/intents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // The list must use the operator's institution — never one
    // passed in via query string.
    expect(received).toEqual([{ institutionId: us2InstitutionId }]);
  });
});
