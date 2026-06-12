import { PublicError } from "../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import type { AdmitAgentRequest, AgentAdmission } from "../models/agent.js";

export interface AgentAdmissionService {
  admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission>;
}

export class AgentService implements AgentAdmissionService {
  private readonly authorization: AgentAuthorizationFacade;

  public constructor(authorization: AgentAuthorizationFacade) {
    this.authorization = authorization;
  }

  public async admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission> {
    const verification = await this.authorization.verifyAgentAuthority({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityProof: request.authorityProof,
      requestedAction: "agent.admit",
    });

    if (verification.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    return {
      agentDid: request.agentDid,
      status: "admitted",
      authorityRef: verification.authorityRef,
    };
  }
}
