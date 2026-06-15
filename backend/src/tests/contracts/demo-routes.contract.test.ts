import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type {
  DemoAgentOrchestrator,
  DemoStatus,
} from "../../services/demo-orchestrator.js";
import type { ApiKeyManagementService } from "../../services/api-key.service.js";
import {
  buildBackendTestEnv,
  us1OperatorInstitutionId,
} from "../data/us1-seed-builders.js";

class StubOrchestrator implements DemoAgentOrchestrator {
  public startCalls = 0;
  public stopCalls = 0;
  public statusCalls = 0;
  public nextStartStatus: DemoStatus = {
    running: true,
    buyerPid: 1234,
    sellerPid: 1235,
    startedAt: "2026-06-15T12:00:00.000Z",
    institutionId: us1OperatorInstitutionId,
  };
  public nextStopStatus: DemoStatus = { running: false };

  public async startDemo(): Promise<DemoStatus> {
    this.startCalls += 1;
    return this.nextStartStatus;
  }
  public async stopDemo(): Promise<DemoStatus> {
    this.stopCalls += 1;
    return this.nextStopStatus;
  }
  public getStatus(): DemoStatus {
    this.statusCalls += 1;
    return this.nextStartStatus;
  }
}

function buildServices(orchestrator: DemoAgentOrchestrator): BackendServices {
  const apiKeyService = {
    createKey: async () => {
      throw new Error("not used in this test");
    },
    listKeys: async () => [],
    revokeKey: async () => {},
    findKeyByToken: async () => null,
  } as unknown as ApiKeyManagementService;
  return {
    institutionService: {
      createInstitution: async () => {
        throw new Error("not used");
      },
    } as never,
    portfolioService: {} as never,
    agentService: {} as never,
    apiKeyService,
    demoAgentOrchestrator: orchestrator,
  };
}

function operatorToken(institutionId: string): string {
  return issueOperatorSessionToken({
    secret: "development-only-auth-session-secret-change-before-production",
    did: "did:t3n:operator:us1",
    institutionId,
  });
}

describe("Demo Mode HTTP surface", () => {
  it("GET /api/demo/status returns the orchestrator's status when running", async () => {
    const orchestrator = new StubOrchestrator();
    const app = createApp(buildBackendTestEnv(), buildServices(orchestrator));

    const token = operatorToken(us1OperatorInstitutionId);
    const response = await request(app)
      .get("/api/demo/status")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      running: true,
      buyerPid: 1234,
      sellerPid: 1235,
    });
    expect(orchestrator.statusCalls).toBe(1);
  });

  it("POST /api/demo/stop is idempotent (returns the orchestrator's stop result)", async () => {
    const orchestrator = new StubOrchestrator();
    const app = createApp(buildBackendTestEnv(), buildServices(orchestrator));

    const token = operatorToken(us1OperatorInstitutionId);
    const response = await request(app)
      .post("/api/demo/stop")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ running: false });
    expect(orchestrator.stopCalls).toBe(1);
  });

  it("POST /api/demo/start rejects cross-institution requests with 403", async () => {
    const orchestrator = new StubOrchestrator();
    const app = createApp(buildBackendTestEnv(), buildServices(orchestrator));

    const token = operatorToken(us1OperatorInstitutionId);
    const response = await request(app)
      .post("/api/demo/start")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionId: "00000000-0000-4000-8000-000000000102",
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: "authorization_failed",
      message: "The requested action is not authorized.",
    });
    expect(orchestrator.startCalls).toBe(0);
  });

  it("POST /api/demo/start rejects malformed bodies with 400", async () => {
    const orchestrator = new StubOrchestrator();
    const app = createApp(buildBackendTestEnv(), buildServices(orchestrator));

    const token = operatorToken(us1OperatorInstitutionId);
    const response = await request(app)
      .post("/api/demo/start")
      .set("Authorization", `Bearer ${token}`)
      .send({ institutionId: "not-a-uuid" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("validation_failed");
    expect(orchestrator.startCalls).toBe(0);
  });
});
