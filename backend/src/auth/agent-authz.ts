import type {
  DashboardDelegationAgentAuthClient,
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
  BoundbuyerVerificationRequest,
  BoundbuyerVerificationResult,
} from "@ghostbroker/t3-enclave";
import { verifyBoundbuyerDelegationCredential } from "@ghostbroker/t3-enclave";
import { PublicError } from "../errors/public-error.js";

export interface AgentAuthorizationFacade {
  verifyAgentAuthority(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
  /**
   * Boundbuyer-style W3C Verifiable Credential path. Called when the
   * agent submits a `delegationCredential` field alongside (or
   * instead of) the JCS `authorityProof`. Returns the same shape
   * as `verifyAgentAuthority` so the rest of the admit pipeline
   * (admitAgent → matching orchestrator) is identical for both
   * credential formats.
   *
   * Optional on the interface so test stubs that only exercise the
   * JCS path don't have to implement it. Production code uses the
   * full `T3AgentAuthorizationFacade`.
   */
  verifyBoundbuyerAuthority?(
    request: BoundbuyerVerificationRequest,
  ): Promise<BoundbuyerVerificationResult>;
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

  public async verifyBoundbuyerAuthority(
    request: BoundbuyerVerificationRequest,
  ): Promise<BoundbuyerVerificationResult> {
    const result = await verifyBoundbuyerDelegationCredential(request);

    if (result.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    return result;
  }
}
