import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AuthSessionService } from "../../services/auth.service.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import type { ApiKeyManagementService } from "../../services/api-key.service.js";
import type { ApiKey } from "../../models/api-key.js";
import {
  buildBackendTestEnv,
  buildInstitution,
} from "../data/us1-seed-builders.js";

function buildServices(
  authService: AuthSessionService,
  apiKeyService: ApiKeyManagementService,
): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService: {
      admitAgent: async () => ({
        agentDid: "did:t3:0x0000000000000000000000000000000000000301",
        status: "admitted",
        authorityRef: "authority:test",
      }),
      listAgents: async () => {
        throw new Error("not used");
      },
      getAgent: async () => {
        throw new Error("not used");
      },
      updateAgentLabel: async () => {
        throw new Error("not used");
      },
      revokeAgent: async () => {
        throw new Error("not used");
      },
    } as AgentManagementService,
    authService,
    portfolioService: {} as never,
    apiKeyService,
  };
}

describe("API key authentication contract", () => {
  it("exchanges a valid API key for a bearer session", async () => {
    const keyRecord = {
      id: "00000000-0000-4000-8000-000000000301",
      institutionId: "00000000-0000-4000-8000-000000000101",
      label: "deploy-key",
      prefix: "gbk_test",
      scopes: "agents:write",
      createdAt: "2026-06-14T00:00:00.000Z",
    } as unknown as ApiKey;

    const authService: AuthSessionService = {
      createChallenge: async () => {
        throw new Error("not used");
      },
      verifyChallenge: async () => {
        throw new Error("not used");
      },
      authenticateWithApiKey: async (apiKey) => {
        expect(apiKey).toBe("gbk_live_test_key");
        return {
          token: "session.jwt.api_key",
          expiresAt: "2026-06-14T08:00:00.000Z",
          institution: {
            id: keyRecord.institutionId,
            displayName: "Northstar Capital",
            t3TenantDid: "did:t3n:tenant:northstar",
          },
        };
      },
    };

    const apiKeyService = {
      findKeyByToken: async () => keyRecord,
    } as unknown as ApiKeyManagementService;

    const app = createApp(buildBackendTestEnv(), buildServices(authService, apiKeyService));

    const response = await request(app)
      .post("/api/auth/api-key")
      .send({ apiKey: "gbk_live_test_key" })
      .expect(200);

    expect(response.body).toEqual({
      token: "session.jwt.api_key",
      expiresAt: "2026-06-14T08:00:00.000Z",
      institution: {
        id: "00000000-0000-4000-8000-000000000101",
        displayName: "Northstar Capital",
        t3TenantDid: "did:t3n:tenant:northstar",
      },
    });
  });

  it("rejects an empty body with a 400 validation error", async () => {
    const authService: AuthSessionService = {
      createChallenge: async () => {
        throw new Error("not used");
      },
      verifyChallenge: async () => {
        throw new Error("not used");
      },
      authenticateWithApiKey: async () => {
        throw new Error("not used");
      },
    };

    const apiKeyService = {
      findKeyByToken: async () => null,
    } as unknown as ApiKeyManagementService;

    const app = createApp(buildBackendTestEnv(), buildServices(authService, apiKeyService));

    const response = await request(app)
      .post("/api/auth/api-key")
      .send({})
      .expect(400);

    expect(response.body.code).toBe("validation_failed");
  });

  it("rejects an unknown API key with a 401 authorization error", async () => {
    const authService: AuthSessionService = {
      createChallenge: async () => {
        throw new Error("not used");
      },
      verifyChallenge: async () => {
        throw new Error("not used");
      },
      authenticateWithApiKey: async () => {
        throw new (await import("../../errors/public-error.js")).PublicError(
          "authorization_failed",
          401,
        );
      },
    };

    const apiKeyService = {
      findKeyByToken: async () => null,
    } as unknown as ApiKeyManagementService;

    const app = createApp(buildBackendTestEnv(), buildServices(authService, apiKeyService));

    const response = await request(app)
      .post("/api/auth/api-key")
      .send({ apiKey: "gbk_unknown_key" })
      .expect(401);

    expect(response.body.code).toBe("authorization_failed");
  });
});
