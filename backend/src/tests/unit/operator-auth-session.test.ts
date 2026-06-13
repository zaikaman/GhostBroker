import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentAdmissionService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildAdmitAgentRequest,
  buildBackendTestEnv,
  buildInstitution,
  us1OperatorInstitutionId,
} from "../data/us1-seed-builders.js";

const authSecret = "test-auth-session-secret-with-more-than-32-characters";

function buildServices(agentService: AgentAdmissionService): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
  };
}

describe("operator auth bearer sessions", () => {
  it("uses the verified DID session as the institution scope", async () => {
    const token = issueOperatorSessionToken({
      secret: authSecret,
      did: "did:t3:0x0000000000000000000000000000000000000301",
      institutionId: us1OperatorInstitutionId,
    });
    const app = createApp(
      {
        ...buildBackendTestEnv(),
        AUTH_SESSION_SECRET: authSecret,
      },
      buildServices({
        admitAgent: async () => ({
          agentDid: "did:t3n:agent:us1-authorized",
          status: "admitted",
          authorityRef: "authority:session:test",
        }),
      }),
    );

    const response = await request(app)
      .post("/api/agents/admit")
      .set("Authorization", `Bearer ${token}`)
      .send(buildAdmitAgentRequest())
      .expect(200);

    expect(response.body.authorityRef).toBe("authority:session:test");
  });

  it("rejects requests without a Bearer token", async () => {
    const app = createApp(
      {
        ...buildBackendTestEnv(),
        AUTH_SESSION_SECRET: authSecret,
      },
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
      .send(buildAdmitAgentRequest())
      .expect(401);

    expect(response.body).toEqual({
      code: "authorization_failed",
      message: "The requested action is not authorized.",
    });
  });
});
