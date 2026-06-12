import { PublicError } from "../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import type { AdmitAgentRequest, AgentAdmission } from "../models/agent.js";
import {
  EmptyAuthorityRevocationRepository,
  type AuthorityRevocationRepository,
} from "./authority-revocation.service.js";

export interface AgentAdmissionService {
  admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission>;
}

export class AgentService implements AgentAdmissionService {
  private readonly authorization: AgentAuthorizationFacade;
  private readonly revocations: AuthorityRevocationRepository;

  public constructor(
    authorization: AgentAuthorizationFacade,
    revocations: AuthorityRevocationRepository = new EmptyAuthorityRevocationRepository(),
  ) {
    this.authorization = authorization;
    this.revocations = revocations;
  }

  public async admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission> {
    const revokedAuthorityRefs =
      await this.revocations.listRevokedAuthorityRefs(
        request.institutionId,
        request.agentDid,
      );
    const verification = await this.authorization.verifyAgentAuthority({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityProof: request.authorityProof,
      requestedAction: "agent.admit",
      revokedAuthorityRefs,
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
