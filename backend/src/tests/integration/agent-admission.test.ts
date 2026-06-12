import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
} from "@ghostbroker/t3-enclave";
import { PublicError } from "../../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { AgentService } from "../../services/agent.service.js";
import type { AuthorityRevocationRepository } from "../../services/authority-revocation.service.js";
import { buildAdmitAgentRequest } from "../data/us1-seed-builders.js";

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
    return { ...this.result, agentDid: request.agentDid };
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
    const service = new AgentService(
      new StaticAuthorization({
        status: "verified",
        agentDid: "did:t3n:agent:placeholder",
        authorityRef: "authority:valid",
        policyHash: "policy:valid",
      }),
    );

    await expect(service.admitAgent(buildAdmitAgentRequest())).resolves.toEqual({
      agentDid: "did:t3n:agent:us1-authorized",
      status: "admitted",
      authorityRef: "authority:valid",
    });
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
      new StaticRevocations(revokedAuthorityRefs),
    );

    await expect(service.admitAgent(buildAdmitAgentRequest())).rejects.toThrow(
      PublicError,
    );
  });
});
