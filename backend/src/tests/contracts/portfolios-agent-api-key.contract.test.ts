import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../../services/hidden-intent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import type { ApiKeyManagementService } from "../../services/api-key.service.js";
import type { ApiKey } from "../../models/api-key.js";
import { PortfolioService } from "../../services/portfolio.service.js";
import type { MatchingOrchestrator } from "../../services/matching-orchestrator.js";
import type { PendingIntent } from "../../models/hidden-intent.js";
import {
  buildBackendTestEnv,
  us2AgentDid,
  us2InstitutionId,
} from "../data/us2-encrypted-intent-builders.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";

function buildServices(options: {
  apiKeyService: ApiKeyManagementService;
  portfolioService: PortfolioService;
  matchingOrchestrator?: MatchingOrchestrator;
}): BackendServices {
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
    } as AgentManagementService,
    hiddenIntentService: {
      submitIntent: async () => {
        throw new Error("not used");
      },
      cancelIntent: async () => {
        throw new Error("not used");
      },
      listPendingIntents: () => [],
    } as HiddenIntentSubmissionService,
    portfolioService: options.portfolioService,
    apiKeyService: options.apiKeyService,
    ...(options.matchingOrchestrator
      ? { matchingOrchestrator: options.matchingOrchestrator }
      : {}),
  };
}

const buyIntent: PendingIntent = {
  correlationRef: "corr_buy_apikey_1",
  institutionId: us2InstitutionId,
  agentDid: us2AgentDid,
  intentHandle: "intent_buy_apikey_1",
  executionRef: "t3exec_buy_apikey_1",
  encryptedEnvelope: "t3env.ciphertext.buy.apikey",
  authorityRef: "authority:buy:apikey:1",
  assetCode: "WBTC",
  side: "buy",
  quantity: 1,
  price: 50000,
  sealedAt: "2026-06-14T00:00:00.000Z",
};

class StubOrchestrator {
  public readonly settlementAssetCode = "USDC";
  public intents: PendingIntent[] = [];
  public listPendingIntents(
    params: { institutionId: string; agentDid?: string },
  ): readonly PendingIntent[] {
    return this.intents.filter(
      (i) =>
        i.institutionId === params.institutionId &&
        (!params.agentDid || i.agentDid === params.agentDid),
    );
  }
}

const API_KEY_TOKEN = "gbk_live_agent_test_key";
const API_KEY_ID = "00000000-0000-4000-8000-000000000901";
const API_KEY_INSTITUTION_ID = us2InstitutionId;

const apiKeyRecord = {
  id: API_KEY_ID,
  institutionId: API_KEY_INSTITUTION_ID,
  label: "agent-test-key",
  prefix: "gbk_live",
  scopes: "agents:write",
  createdAt: "2026-06-14T00:00:00.000Z",
} as unknown as ApiKey;

const apiKeyService = {
  findKeyByToken: async (token: string) => {
    if (token === API_KEY_TOKEN) return apiKeyRecord;
    return null;
  },
} as unknown as ApiKeyManagementService;

describe("GET /api/portfolios/:institutionId?agentDid=... via API key (agent)", () => {
  it("returns the agent-level view to an authenticated agent (gbk_ API key)", async () => {
    const portfolioClient = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: API_KEY_INSTITUTION_ID,
        assetCode: "USDC",
        balance: 1000000,
        locked: 100000,
      }),
      makePortfolioRecord({
        institutionId: API_KEY_INSTITUTION_ID,
        assetCode: "WBTC",
        balance: 5,
        locked: 0,
      }),
    ]);
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator = new StubOrchestrator();
    orchestrator.intents = [buyIntent];

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        apiKeyService,
        portfolioService,
        matchingOrchestrator: orchestrator as unknown as MatchingOrchestrator,
      }),
    );

    const response = await request(app)
      .get(
        `/api/portfolios/${API_KEY_INSTITUTION_ID}?agentDid=${encodeURIComponent(us2AgentDid)}`,
      )
      .set("Authorization", `Bearer ${API_KEY_TOKEN}`)
      .expect(200);

    expect(response.body).toEqual({
      institutionId: API_KEY_INSTITUTION_ID,
      agentDid: us2AgentDid,
      holdings: [
        { assetCode: "USDC", balance: 1000000, locked: 100000 },
        { assetCode: "WBTC", balance: 5, locked: 0 },
      ],
      pendingReservations: [
        {
          intentHandle: "intent_buy_apikey_1",
          assetCode: "USDC",
          amount: 50000, // 1 * 50000
          side: "buy",
          quantity: 1,
          price: 50000,
        },
      ],
    });
  });

  it("returns 401 when the API key is unknown", async () => {
    const portfolioService = new PortfolioService(
      new InMemoryPortfolioClient() as never,
      "USDC",
    );

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({ apiKeyService, portfolioService }),
    );

    await request(app)
      .get(
        `/api/portfolios/${API_KEY_INSTITUTION_ID}?agentDid=${encodeURIComponent(us2AgentDid)}`,
      )
      .set("Authorization", `Bearer gbk_unknown_key`)
      .expect(401);
  });

  it("returns 403 when the API key belongs to a different institution", async () => {
    const portfolioService = new PortfolioService(
      new InMemoryPortfolioClient() as never,
      "USDC",
    );

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({ apiKeyService, portfolioService }),
    );

    // The API key is scoped to us2InstitutionId; querying a
    // different institution must be rejected with 403.
    await request(app)
      .get(
        "/api/portfolios/00000000-0000-4000-8000-000000000999?agentDid=" +
          encodeURIComponent(us2AgentDid),
      )
      .set("Authorization", `Bearer ${API_KEY_TOKEN}`)
      .expect(403);
  });

  it("returns 400 for a malformed agentDid query parameter", async () => {
    const portfolioService = new PortfolioService(
      new InMemoryPortfolioClient() as never,
      "USDC",
    );

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({ apiKeyService, portfolioService }),
    );

    await request(app)
      .get(
        `/api/portfolios/${API_KEY_INSTITUTION_ID}?agentDid=not-a-did`,
      )
      .set("Authorization", `Bearer ${API_KEY_TOKEN}`)
      .expect(400);
  });
});
