import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import type { NegotiationManagementService } from "../../services/negotiation.service.js";
import {
  buildBackendTestEnv,
  buildInstitution,
  TEST_AUTH_SESSION_SECRET,
  us1OperatorInstitutionId,
} from "../data/us1-seed-builders.js";

const agentId = "00000000-0000-4000-8000-000000000401";
const selectedMandateId = "00000000-0000-4000-8000-000000000501";
const newerMandateId = "00000000-0000-4000-8000-000000000502";

function buildServices(
  negotiationService: NegotiationManagementService,
): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
      getInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService: {
      admitAgent: async () => {
        throw new Error("not used");
      },
      listAgents: async () => [],
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
    } satisfies AgentManagementService,
    negotiationService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
  };
}

function issueToken(did = "did:t3n:operator:us1"): string {
  return issueOperatorSessionToken({
    secret: TEST_AUTH_SESSION_SECRET,
    did,
    institutionId: us1OperatorInstitutionId,
  });
}

describe("GET /api/agents/:id/mandate contract", () => {
  it("returns the specific mandate when mandateId is provided", async () => {
    const selectedMandate = {
      id: selectedMandateId,
      institutionId: us1OperatorInstitutionId,
      agentId,
      agentDid: "did:t3n:agent:us1",
      assetCode: "WBTC",
      side: "buy" as const,
      targetQuantity: "2",
      referencePrice: "100000",
      priceBandBps: 150,
      deadline: "2026-07-01T00:00:00.000Z",
      urgency: "normal" as const,
      maxNotional: "200000",
      disclosableClaims: [],
      requiredCounterpartyClaims: {},
      counterpartyConstraints: {},
      operatorPrompt: "Respect the configured mandate.",
      policyHash: "policy:selected",
      objective: null,
      executionStyle: null,
      valuationPolicy: null,
      concessionPolicy: null,
      disclosurePolicy: null,
      approvalPolicy: null,
      counterpartyRequirements: null,
      sizePolicy: null,
      timeWindow: null,
      operatorInstructions: null,
      minimumQuantity: null,
      partialExecutionAllowed: null,
      derivedAnchorValue: null,
      derivedWalkawayMin: null,
      derivedWalkawayMax: null,
      derivedConcessionBudgetBps: null,
      derivedNotionalCeiling: null,
      decisionMeta: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    const negotiationService: NegotiationManagementService = {
      createMandate: async () => {
        throw new Error("not used");
      },
      getMandateByAgent: async () => ({
        ...selectedMandate,
        id: newerMandateId,
        policyHash: "policy:newer",
      }),
      listMandatesByAgent: async () => [selectedMandate],
      getMandate: async (_institutionId, mandateId) => {
        if (mandateId !== selectedMandateId) {
          throw new Error("unexpected mandate lookup");
        }
        return selectedMandate;
      },
      submitTicket: async () => {
        throw new Error("not used");
      },
      submitMove: async () => {
        throw new Error("not used");
      },
      approveEscalation: async () => {
        throw new Error("not used");
      },
      declineEscalation: async () => {
        throw new Error("not used");
      },
      listSessions: async () => {
        throw new Error("not used");
      },
      getSession: async () => {
        throw new Error("not used");
      },
    };

    const app = createApp(buildBackendTestEnv(), buildServices(negotiationService));

    const response = await request(app)
      .get(`/api/agents/${agentId}/mandate`)
      .query({ mandateId: selectedMandateId })
      .set("Authorization", `Bearer ${issueToken()}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: selectedMandateId,
      agentId,
      policyHash: "policy:selected",
    });
  });
});

describe("GET /api/negotiations contract", () => {
  it("passes a same-DID agent filter to the negotiation service", async () => {
    const agentDid = "did:t3n:demo-hosted-agent";
    let capturedAgentDid: string | undefined;
    const negotiationService: NegotiationManagementService = {
      createMandate: async () => {
        throw new Error("not used");
      },
      getMandateByAgent: async () => {
        throw new Error("not used");
      },
      listMandatesByAgent: async () => {
        throw new Error("not used");
      },
      getMandate: async () => {
        throw new Error("not used");
      },
      submitTicket: async () => {
        throw new Error("not used");
      },
      submitMove: async () => {
        throw new Error("not used");
      },
      approveEscalation: async () => {
        throw new Error("not used");
      },
      declineEscalation: async () => {
        throw new Error("not used");
      },
      listSessions: async (_institutionId, requestedAgentDid) => {
        capturedAgentDid = requestedAgentDid;
        return [];
      },
      getSession: async () => {
        throw new Error("not used");
      },
    };

    const app = createApp(buildBackendTestEnv(), buildServices(negotiationService));

    await request(app)
      .get("/api/negotiations")
      .query({ agentDid })
      .set("Authorization", `Bearer ${issueToken(agentDid)}`)
      .expect(200);

    expect(capturedAgentDid).toBe(agentDid);
  });

  it("rejects an agent filter that does not match the authenticated DID", async () => {
    let listCalled = false;
    const negotiationService: NegotiationManagementService = {
      createMandate: async () => {
        throw new Error("not used");
      },
      getMandateByAgent: async () => {
        throw new Error("not used");
      },
      listMandatesByAgent: async () => {
        throw new Error("not used");
      },
      getMandate: async () => {
        throw new Error("not used");
      },
      submitTicket: async () => {
        throw new Error("not used");
      },
      submitMove: async () => {
        throw new Error("not used");
      },
      approveEscalation: async () => {
        throw new Error("not used");
      },
      declineEscalation: async () => {
        throw new Error("not used");
      },
      listSessions: async () => {
        listCalled = true;
        return [];
      },
      getSession: async () => {
        throw new Error("not used");
      },
    };

    const app = createApp(buildBackendTestEnv(), buildServices(negotiationService));

    await request(app)
      .get("/api/negotiations")
      .query({ agentDid: "did:t3n:other-agent" })
      .set("Authorization", `Bearer ${issueToken("did:t3n:demo-hosted-agent")}`)
      .expect(403);

    expect(listCalled).toBe(false);
  });
});
