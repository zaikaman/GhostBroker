import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type BackendServices } from "../../app.js";
import { issueOperatorSessionToken } from "../../auth/session-token.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import {
  buildAdmitAgentRequest,
  buildBackendTestEnv,
  buildInstitution,
  us1AgentDid,
  us1OperatorInstitutionId,
} from "../data/us1-seed-builders.js";

function buildServices(agentService: AgentManagementService): BackendServices {
  return {
    institutionService: {
      createInstitution: async () => buildInstitution(),
    } satisfies InstitutionManagementService,
    agentService,
    portfolioService: {} as never,
    apiKeyService: {} as never,
  };
}

describe("POST /api/agents/admit contract", () => {
  it("admits a verified agent and returns only the authority reference", async () => {
    const agentService: AgentManagementService = {
      admitAgent: async () => ({
        agentDid: "did:t3n:agent:us1-authorized",
        status: "admitted",
        authorityRef: "authority:verified:test",
      }),            listAgents: async () => { throw new Error("not used"); },
            getAgent: async () => { throw new Error("not used"); },
            updateAgentLabel: async () => { throw new Error("not used"); },
          revokeAgent: async () => { throw new Error("not used"); },
        persistDelegation: async () => { throw new Error("not used"); },
        loadDelegationCredential: async () => null,
        configureAgent: async () => { throw new Error("not used"); },
      };
    const app = createApp(buildBackendTestEnv(), buildServices(agentService));

    const token = issueOperatorSessionToken({
      secret: "development-only-auth-session-secret-change-before-production",
      did: "did:t3n:operator:us1",
      institutionId: us1OperatorInstitutionId,
    });

    const response = await request(app)
      .post("/api/agents/admit")
      .set("Authorization", `Bearer ${token}`)
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
        listAgents: async () => { throw new Error("not used"); },
        getAgent: async () => { throw new Error("not used"); },
        updateAgentLabel: async () => { throw new Error("not used"); },
        revokeAgent: async () => { throw new Error("not used"); },
        persistDelegation: async () => { throw new Error("not used"); },
        loadDelegationCredential: async () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

    const token = issueOperatorSessionToken({
      secret: "development-only-auth-session-secret-change-before-production",
      did: "did:t3n:operator:us1",
      institutionId: us1OperatorInstitutionId,
    });

    const response = await request(app)
      .post("/api/agents/admit")
      .set("Authorization", `Bearer ${token}`)
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

  it("configures and auto-admits an operator-ready agent", async () => {
    const agentService: AgentManagementService = {
      admitAgent: async () => ({
        id: "00000000-0000-4000-8000-000000000401",
        agentDid: us1AgentDid,
        status: "admitted",
        authorityRef: "ghostbroker-delegation:test-authority",
      }),
      listAgents: async () => { throw new Error("not used"); },
      getAgent: async () => ({
        id: "00000000-0000-4000-8000-000000000401",
        institutionId: us1OperatorInstitutionId,
        agentDid: us1AgentDid,
        status: "admitted",
        authorityRef: "ghostbroker-delegation:test-authority",
        label: "Northstar Negotiator",
        instrumentScope: null,
        directionScope: null,
        maxNotional: null,
        limitReference: null,
        policyHash: "policy-hash-123",
        metadata: {
          delegation_credential: { id: "urn:uuid:test-delegation" },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      updateAgentLabel: async () => { throw new Error("not used"); },
      revokeAgent: async () => { throw new Error("not used"); },
      persistDelegation: async () => { throw new Error("not used"); },
      loadDelegationCredential: async () => null,
      configureAgent: async () => ({
        agent: {
          id: "00000000-0000-4000-8000-000000000401",
          institutionId: us1OperatorInstitutionId,
          agentDid: us1AgentDid,
          status: "admitted",
          authorityRef: "ghostbroker-delegation:test-authority",
          label: "Northstar Negotiator",
          instrumentScope: null,
          directionScope: null,
          maxNotional: null,
          limitReference: null,
          policyHash: "policy-hash-123",
          metadata: {
            delegation_credential: { id: "urn:uuid:test-delegation" },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        policyHash: "policy-hash-123",
      }),
    };

    const app = createApp(buildBackendTestEnv(), {
      ...buildServices(agentService),
      tenantDelegationSigner: {
        mint: async () => ({
          credential: {
            id: "urn:uuid:test-delegation",
            type: ["VerifiableCredential", "GhostBrokerDelegation"],
            issuer: "did:t3n:test-tenant",
            issuanceDate: "2026-01-01T00:00:00.000Z",
            expirationDate: "2027-01-01T00:00:00.000Z",
            credentialSubject: {
              id: "did:t3n:test-tenant",
              agentDid: us1AgentDid,
              maxSpendUsd: 1,
              allowedCategories: ["services"],
              purpose: "Negotiate within mandate bounds",
            },
            proof: {
              type: "JsonWebSignature2020",
              created: "2026-01-01T00:00:00.000Z",
              proofPurpose: "assertionMethod",
              verificationMethod: "did:t3n:test-tenant#key-1",
              jws: "signed",
            },
          },
          policyHash: "policy-hash-123",
        }),
      },
    });

    const token = issueOperatorSessionToken({
      secret: "development-only-auth-session-secret-change-before-production",
      did: "did:t3n:operator:us1",
      institutionId: us1OperatorInstitutionId,
    });

    const response = await request(app)
      .post("/api/agents/configure")
      .set("Authorization", `Bearer ${token}`)
      .send({
        institutionId: us1OperatorInstitutionId,
        label: "Northstar Negotiator",
        policy: {
          maxSpendUsd: 1,
          allowedCategories: ["services"],
          purpose: "Negotiate within mandate bounds",
        },
      })
      .expect(201);

    expect(response.body).toMatchObject({
      agent: {
        id: "00000000-0000-4000-8000-000000000401",
        agentDid: us1AgentDid,
        status: "admitted",
        label: "Northstar Negotiator",
      },
      admission: {
        id: "00000000-0000-4000-8000-000000000401",
        agentDid: us1AgentDid,
        status: "admitted",
        authorityRef: "ghostbroker-delegation:test-authority",
      },
      policyHash: "policy-hash-123",
    });
  });
});
