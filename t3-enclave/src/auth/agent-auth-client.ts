import type { T3NetworkClient } from "../sandbox/t3n-client.js";
import { verifySignedDelegationProof } from "./delegation-credential.js";

export type RequestedAgentAction = "agent.admit" | "intent.submit" | "settlement.execute";

export interface AgentDelegationVerificationRequest {
  institutionId: string;
  agentDid: string;
  authorityProof: string;
  requestedAction: RequestedAgentAction;
}

export type AgentDelegationRejectionReason =
  | "expired"
  | "revoked"
  | "over_scoped"
  | "unverified";

export interface VerifiedAgentDelegation {
  status: "verified";
  agentDid: string;
  authorityRef: string;
  policyHash: string;
}

export interface RejectedAgentDelegation {
  status: "rejected";
  agentDid: string;
  reason: AgentDelegationRejectionReason;
}

export type AgentDelegationVerificationResult =
  | VerifiedAgentDelegation
  | RejectedAgentDelegation;

export interface AgentDelegationVerifier {
  verifyDelegation(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult>;
}

export class DashboardDelegationAgentAuthClient
  implements AgentDelegationVerifier
{
  private readonly client: T3NetworkClient;
  private readonly verificationPath: string;

  public constructor(
    client: T3NetworkClient,
    verificationPath = "/agent-delegations/verify",
  ) {
    this.client = client;
    this.verificationPath = verificationPath;
  }

  public async verifyDelegation(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentDelegationVerificationResult> {
    const signedProofResult = verifySignedDelegationProof(request);

    if (signedProofResult.status === "verified") {
      return signedProofResult;
    }

    const response =
      await this.client.request<AgentDelegationVerificationResult>({
        method: "POST",
        path: this.verificationPath,
        body: request,
      });

    if (response.status < 200 || response.status >= 300) {
      return {
        status: "rejected",
        agentDid: request.agentDid,
        reason: "unverified",
      };
    }

    if (response.body.status === "verified") {
      return response.body;
    }

    return {
      status: "rejected",
      agentDid: request.agentDid,
      reason: response.body.reason,
    };
  }
}
