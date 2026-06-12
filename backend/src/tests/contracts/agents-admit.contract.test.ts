import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AgentAdmissionService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildAdmitAgentRequest,
  buildBackendTestEnv,
  buildInstitution,
  us1OperatorInstitutionId,
} from "../data/us1-seed-builders.js";

function buildServices(agentService: AgentAdmissionService): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService,
  };
}

describe("POST /api/agents/admit contract", () => {
  it("admits a verified agent and returns only the authority reference", async () => {
    const agentService: AgentAdmissionService = {
      admitAgent: async () => ({
        agentDid: "did:t3n:agent:us1-authorized",
        status: "admitted",
        authorityRef: "authority:verified:test",
      }),
    };
    const app = createApp(buildBackendTestEnv(), buildServices(agentService));

    const response = await request(app)
      .post("/api/agents/admit")
      .set("x-operator-institution-id", us1OperatorInstitutionId)
      .send(buildAdmitAgentRequest())
      .expect(200);

    expect(response.body).toEqual({
      agentDid: "did:t3n:agent:us1-authorized",
      status: "admitted",
      authorityRef: "authority:verified:test",
    });
  });

  it("rejects cross-institution admission with a redacted response", async () => {
    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        admitAgent: async () => ({
          agentDid: "did:t3n:agent:unexpected",
          status: "admitted",
          authorityRef: "authority:unexpected",
        }),
      }),
    );

    const response = await request(app)
      .post("/api/agents/admit")
      .set("x-operator-institution-id", us1OperatorInstitutionId)
      .send(
        buildAdmitAgentRequest({
          institutionId: "00000000-0000-4000-8000-000000000102",
        }),
      )
      .expect(403);

    expect(response.body).toEqual({
      code: "authorization_failed",
      message: "The requested action is not authorized.",
    });
  });
});
