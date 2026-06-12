import type {
  DashboardDelegationAgentAuthClient,
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
} from "@ghostbroker/t3-enclave";
import { PublicError } from "../errors/public-error.js";

export interface AgentAuthorizationFacade {
  verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
}

export class T3AgentAuthorizationFacade implements AgentAuthorizationFacade {
  private readonly client: DashboardDelegationAgentAuthClient;

  public constructor(client: DashboardDelegationAgentAuthClient) {
    this.client = client;
  }

  public async verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    const result = await this.client.verifyDelegation(request);

    if (result.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    return result;
  }
}
