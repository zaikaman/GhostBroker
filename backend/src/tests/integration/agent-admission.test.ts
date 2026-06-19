import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
} from "../../enclave/index.js";
import { PublicError } from "../../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { AgentService } from "../../services/agent.service.js";
import type { AuthorityRevocationRepository } from "../../services/authority-revocation.service.js";
import { FakeAgentRepository } from "../data/fake-agent-repository.js";
import {
  buildAdmitAgentRequest,
  us1AgentDid,
  us1OperatorInstitutionId,
} from "../data/us1-seed-builders.js";

class StaticAuthorization implements AgentAuthorizationFacade {
  private readonly result: AgentDelegationVerificationResult;
  private readonly onVerify:
    | ((request: AgentDelegationVerificationRequest) => void)
    | undefined;

  public constructor(
    result: AgentDelegationVerificationResult,
    onVerify?: (request: AgentDelegationVerificationRequest) => void,
  ) {
    this.result = result;
    this.onVerify = onVerify;
  }

  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    this.onVerify?.(request);
    if (this.result.status === "verified") {
      return {
        ...this.result,
        agentDid: request.agentDid,
        delegationCredential: request.delegationCredential,
      };
    }
    return { ...this.result, agentDid: request.agentDid };
  }

  public async loadAndVerify(): Promise<AgentDelegationVerificationResult> {
    throw new PublicError("authorization_failed", 403);
  }
}

class StaticRevocations implements AuthorityRevocationRepository {
  private readonly refs: ReadonlySet<string>;

  public constructor(refs: ReadonlySet<string>) {
    this.refs = refs;
  }

  public async listRevokedAuthorityRefs(): Promise<ReadonlySet<string>> {
    return this.refs;
  }
}

describe("agent admission", () => {
  it("admits valid delegated agents", async () => {
    // Pre-register the agent so the submit-time / admit-time
    // lookups see the row we expect, with the authority ref
    // the test asserts against.
    const repo = new FakeAgentRepository();
    await repo.create({
      institutionId: us1OperatorInstitutionId,
      agentDid: us1AgentDid,
      authorityRef: "authority:valid",
    });
    const service = new AgentService(
      new StaticAuthorization({
        status: "verified",
        agentDid: "did:t3n:agent:placeholder",
        authorityRef: "authority:valid",
        policyHash: "policy:valid",
        delegationCredential: { id: "vc-us1-authorized" },
      }),
      repo,
    );

    const result = await service.admitAgent(buildAdmitAgentRequest());
    expect(result).toMatchObject({
      agentDid: "did:t3n:agent:us1-authorized",
      status: "admitted",
      authorityRef: "authority:valid",
    });
    // A real id was assigned by the repository
    expect(result.id).toBeDefined();
  });

  it.each(["expired", "revoked", "over_scoped", "unverified"] as const)(
    "rejects %s delegated agents",
    async (reason) => {
      const service = new AgentService(
        new StaticAuthorization({
          status: "rejected",
          agentDid: "did:t3n:agent:placeholder",
          reason,
        }),
        new FakeAgentRepository(),
      );

      await expect(service.admitAgent(buildAdmitAgentRequest())).rejects.toThrow(
        PublicError,
      );
    },
  );

  it("passes persisted revocations into authority verification", async () => {
    const revokedAuthorityRefs = new Set(["t3-delegation:revoked"]);
    const service = new AgentService(
      new StaticAuthorization(
        {
          status: "rejected",
          agentDid: "did:t3n:agent:placeholder",
          reason: "revoked",
        },
        (request) => {
          expect(request.revokedAuthorityRefs).toBe(revokedAuthorityRefs);
        },
      ),
      new FakeAgentRepository(),
      new StaticRevocations(revokedAuthorityRefs),
    );

    await expect(service.admitAgent(buildAdmitAgentRequest())).rejects.toThrow(
      PublicError,
    );
  });
});
