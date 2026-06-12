import { describe, expect, it } from "vitest";
import type {
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
} from "@ghostbroker/t3-enclave";
import { PublicError } from "../../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../../auth/agent-authz.js";
import { AgentService } from "../../services/agent.service.js";
import { buildAdmitAgentRequest } from "../data/us1-seed-builders.js";

class StaticAuthorization implements AgentAuthorizationFacade {
  private readonly result: AgentDelegationVerificationResult;

  public constructor(result: AgentDelegationVerificationResult) {
    this.result = result;
  }

  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    return { ...this.result, agentDid: request.agentDid };
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
});
