import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import type { TeeAuditEventService } from "../../services/tee-audit-event.service.js";
import {
  buildBackendTestEnv,
  TEST_AUTH_SESSION_SECRET,
} from "../data/us2-encrypted-intent-builders.js";

const institutionId = "00000000-0000-4000-8000-000000000401";

function buildServices(
  auditEventService: TeeAuditEventService,
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
      persistDelegation: async () => {
        throw new Error("not used");
      },
      loadDelegationCredential: async () => null,
      configureAgent: async () => {
        throw new Error("not used");
      },
    } as AgentManagementService,
    auditEventService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
  };
}

describe("GET /api/audit-events contract", () => {
  it("returns the AuditPage JSON shape from the TeeAuditEventService", async () => {
    const auditPage = {
      batches: [
        {
          key: "abc123",
          committed: true,
          events: [
            {
              ts_ms: 1719000000000,
              subject: "did:t3n:0xsubject",
              actor: "did:t3n:0xactor",
              vc_id: "vc_001",
              action: "seal-intent",
              target: "blind-intent",
              outcome: "success",
              details: null,
            },
          ],
        },
      ],
      next_cursor: "deadbeef",
    };
    const getAuditEvents = vi
      .fn()
      .mockResolvedValue(auditPage) as unknown as TeeAuditEventService["getAuditEvents"];

    const service: TeeAuditEventService = { getAuditEvents };
    const app = createApp(buildBackendTestEnv(), buildServices(service));

    const token = issueOperatorSessionToken({
      secret: TEST_AUTH_SESSION_SECRET,
      did: "did:t3n:operator:audit",
      institutionId,
    });

    const response = await request(app)
      .get("/api/audit-events?limit=10&cursor=deadbeef")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual(auditPage);
    expect(getAuditEvents).toHaveBeenCalledTimes(1);
    expect(getAuditEvents).toHaveBeenCalledWith({
      limit: 10,
      cursor: "deadbeef",
    });
  });

  it("rejects an invalid cursor with a 400 validation_failed", async () => {
    const getAuditEvents = vi.fn() as unknown as TeeAuditEventService["getAuditEvents"];
    const service: TeeAuditEventService = { getAuditEvents };
    const app = createApp(buildBackendTestEnv(), buildServices(service));

    const token = issueOperatorSessionToken({
      secret: TEST_AUTH_SESSION_SECRET,
      did: "did:t3n:operator:audit",
      institutionId,
    });

    await request(app)
      .get("/api/audit-events?cursor=not-hex!")
      .set("Authorization", `Bearer ${token}`)
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("validation_failed");
      });

    expect(getAuditEvents).not.toHaveBeenCalled();
  });

  it("returns 401 without operator auth", async () => {
    const getAuditEvents = vi.fn() as unknown as TeeAuditEventService["getAuditEvents"];
    const service: TeeAuditEventService = { getAuditEvents };
    const app = createApp(buildBackendTestEnv(), buildServices(service));

    await request(app).get("/api/audit-events").expect(401);

    expect(getAuditEvents).not.toHaveBeenCalled();
  });
});
