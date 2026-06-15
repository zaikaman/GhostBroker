import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../../services/hidden-intent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
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
      listAgents: async () => { throw new Error("not used"); },
      getAgent: async () => { throw new Error("not used"); },
      updateAgentLabel: async () => { throw new Error("not used"); },
      revokeAgent: async () => { throw new Error("not used"); },
      persistDelegation: async () => { throw new Error("not used"); },
      loadDelegationCredential: async () => null,
        configureAgent: async () => { throw new Error("not used"); },
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
    apiKeyService: {} as never,
    ...(options.matchingOrchestrator
      ? { matchingOrchestrator: options.matchingOrchestrator }
      : {}),
  };
}

const buyIntent: PendingIntent = {
  correlationRef: "corr_buy_1",
  institutionId: us2InstitutionId,
  agentDid: us2AgentDid,
  intentHandle: "intent_buy_1",
  executionRef: "t3exec_buy_1",
  encryptedEnvelope: "t3env.ciphertext.buy",
  authorityRef: "authority:buy:1",
  delegationCredential: { id: "vc-buy-1", issuer: "did:t3n:buy" },
  assetCode: "WBTC",
  side: "buy",
  quantity: 2,
  price: 50000,
  sealedAt: "2026-06-12T00:00:00.000Z",
};

const sellIntent: PendingIntent = {
  correlationRef: "corr_sell_1",
  institutionId: us2InstitutionId,
  agentDid: us2AgentDid,
  intentHandle: "intent_sell_1",
  executionRef: "t3exec_sell_1",
  encryptedEnvelope: "t3env.ciphertext.sell",
  authorityRef: "authority:sell:1",
  delegationCredential: { id: "vc-sell-1", issuer: "did:t3n:sell" },
  assetCode: "WBTC",
  side: "sell",
  quantity: 3,
  price: 51000,
  sealedAt: "2026-06-12T00:00:01.000Z",
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

describe("GET /api/portfolios/:institutionId?agentDid=... contract", () => {
  const token = issueOperatorSessionToken({
    secret: "development-only-auth-session-secret-change-before-production",
    did: "did:t3n:operator:us2",
    institutionId: us2InstitutionId,
  });

  it("returns the agent-level view with pending reservations and DB-only holdings", async () => {
    const portfolioClient = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 1000000,
        locked: 100000,
      }),
      makePortfolioRecord({
        institutionId: us2InstitutionId,
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
    orchestrator.intents = [buyIntent, sellIntent];

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        portfolioService,
        matchingOrchestrator: orchestrator as unknown as MatchingOrchestrator,
      }),
    );

    const response = await request(app)
      .get(`/api/portfolios/${us2InstitutionId}?agentDid=${encodeURIComponent(us2AgentDid)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      institutionId: us2InstitutionId,
      agentDid: us2AgentDid,
      holdings: [
        { assetCode: "USDC", balance: 1000000, locked: 100000 },
        { assetCode: "WBTC", balance: 5, locked: 0 },
      ],
      pendingReservations: [
        {
          intentHandle: "intent_buy_1",
          assetCode: "USDC",
          amount: 100000, // 2 * 50000
          side: "buy",
          quantity: 2,
          price: 50000,
        },
        {
          intentHandle: "intent_sell_1",
          assetCode: "WBTC",
          amount: 3, // quantity directly
          side: "sell",
          quantity: 3,
          price: 51000,
        },
      ],
    });
  });

  it("returns 400 for a malformed agentDid query parameter", async () => {
    const portfolioClient = new InMemoryPortfolioClient();
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({ portfolioService }),
    );

    await request(app)
      .get(`/api/portfolios/${us2InstitutionId}?agentDid=not-a-did`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });

  it("returns 403 when querying another institution's portfolio", async () => {
    const portfolioClient = new InMemoryPortfolioClient();
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({ portfolioService }),
    );

    await request(app)
      .get("/api/portfolios/00000000-0000-4000-8000-000000000999")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("returns an empty pendingReservations array when no intents are pending", async () => {
    const portfolioClient = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: us2InstitutionId,
        assetCode: "USDC",
        balance: 100,
        locked: 0,
      }),
    ]);
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator = new StubOrchestrator();

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        portfolioService,
        matchingOrchestrator: orchestrator as unknown as MatchingOrchestrator,
      }),
    );

    const response = await request(app)
      .get(`/api/portfolios/${us2InstitutionId}?agentDid=${encodeURIComponent(us2AgentDid)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.pendingReservations).toEqual([]);
    expect(response.body.holdings).toEqual([
      { assetCode: "USDC", balance: 100, locked: 0 },
    ]);
  });

  it("only returns reservations for the requested agent (filters out other agents)", async () => {
    const portfolioClient = new InMemoryPortfolioClient();
    const portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    const orchestrator = new StubOrchestrator();
    orchestrator.intents = [
      buyIntent,
      {
        ...buyIntent,
        agentDid: "did:t3n:agent:different-agent",
        intentHandle: "intent_other_agent",
        correlationRef: "corr_other",
      },
    ];

    const app = createApp(
      buildBackendTestEnv(),
      buildServices({
        portfolioService,
        matchingOrchestrator: orchestrator as unknown as MatchingOrchestrator,
      }),
    );

    const response = await request(app)
      .get(`/api/portfolios/${us2InstitutionId}?agentDid=${encodeURIComponent(us2AgentDid)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.pendingReservations).toHaveLength(1);
    expect(response.body.pendingReservations[0].intentHandle).toBe(
      "intent_buy_1",
    );
  });
});
