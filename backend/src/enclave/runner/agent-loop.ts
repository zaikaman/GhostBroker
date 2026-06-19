import type {
  AgentDelegationVerifier,
  AgentDelegationVerificationRequest,
  AgentDelegationVerificationResult,
} from "../auth/agent-auth-client.js";
import type { RunnerLifecycle } from "./lifecycle.js";

export interface AgentAdmissionLifecycleResult {
  agentDid: string;
  status: "agent_verified" | "agent_rejected";
  authorityRef?: string;
}

export class AgentAdmissionLoop {
  private readonly verifier: AgentDelegationVerifier;
  private readonly lifecycle: RunnerLifecycle;

  public constructor(
    verifier: AgentDelegationVerifier,
    lifecycle: RunnerLifecycle,
  ) {
    this.verifier = verifier;
    this.lifecycle = lifecycle;
  }

  public async admit(
    request: AgentDelegationVerificationRequest,
  ): Promise<AgentAdmissionLifecycleResult> {
    const result: AgentDelegationVerificationResult =
      await this.verifier.verifyDelegation(request);

    if (result.status === "verified") {
      this.lifecycle.transition("ready");
      return {
        agentDid: result.agentDid,
        status: "agent_verified",
        authorityRef: result.authorityRef,
      };
    }

    this.lifecycle.transition("failed", {
      failureReason: "agent_authority_rejected",
    });
    return {
      agentDid: result.agentDid,
      status: "agent_rejected",
    };
  }
}
