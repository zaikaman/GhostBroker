import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildBackendTestEnv,
  buildCreateInstitutionRequest,
  buildInstitution,
} from "../data/us1-seed-builders.js";

function buildServices(): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService: {
      admitAgent: async () => {
        throw new Error("Agent service is not used by this contract test.");
      },
      listAgents: async () => { throw new Error("not used"); },
      getAgent: async () => { throw new Error("not used"); },
      updateAgentLabel: async () => { throw new Error("not used"); },
      revokeAgent: async () => { throw new Error("not used"); },
      persistDelegation: async () => { throw new Error("not used"); },
      loadDelegationCredential: async () => null,
        configureAgent: async () => { throw new Error("not used"); },
    } as AgentManagementService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
  };
}

describe("POST /api/institutions contract", () => {
  it("creates an institution profile without trading activity fields", async () => {
    const app = createApp(buildBackendTestEnv(), buildServices());

    const response = await request(app)
      .post("/api/institutions")
      .send(buildCreateInstitutionRequest())
      .expect(201);

    expect(response.body).toEqual({
      id: "00000000-0000-4000-8000-000000000101",
      legalName: "Northstar Capital Markets LLC",
      displayName: "Northstar Capital",
      status: "active",
      t3TenantDid: "did:t3n:tenant:northstar",
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /asset|quantity|price|counterparty|queue/iu,
    );
  });

  it("returns a redacted validation error for malformed requests", async () => {
    const app = createApp(buildBackendTestEnv(), buildServices());

    const response = await request(app)
      .post("/api/institutions")
      .send({ displayName: "Incomplete" })
      .expect(400);

    expect(response.body).toEqual({
      code: "validation_failed",
      message: "The request could not be accepted.",
    });
  });
});
