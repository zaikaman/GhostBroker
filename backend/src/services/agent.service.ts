import { PublicError } from "../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import type {
  AdmitAgentRequest,
  AgentAdmission,
  Agent,
  AgentStatus,
  DirectionScope,
} from "../models/agent.js";
import type { AgentRepository } from "./agent-repository.js";
import {
  EmptyAuthorityRevocationRepository,
  type AuthorityRevocationRepository,
} from "./authority-revocation.service.js";
import type { MatchingOrchestrator } from "./matching-orchestrator.js";
import type { BoundbuyerDelegationCredential } from "@ghostbroker/t3-enclave";

export interface AgentAdmissionService {
  admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission>;
}

export interface AgentManagementService extends AgentAdmissionService {
  listAgents(
    institutionId: string,
    status?: AgentStatus,
  ): Promise<Agent[]>;
  getAgent(id: string, institutionId: string): Promise<Agent>;
  updateAgentLabel(id: string, institutionId: string, label: string): Promise<Agent>;
  revokeAgent(id: string, institutionId: string): Promise<void>;
}

export class AgentService implements AgentManagementService {
  private readonly authorization: AgentAuthorizationFacade;
  private readonly revocations: AuthorityRevocationRepository;
  private readonly repository: AgentRepository;
  private readonly matchingOrchestrator: MatchingOrchestrator | undefined;

  public constructor(
    authorization: AgentAuthorizationFacade,
    repository: AgentRepository,
    revocations: AuthorityRevocationRepository = new EmptyAuthorityRevocationRepository(),
    matchingOrchestrator?: MatchingOrchestrator,
  ) {
    this.authorization = authorization;
    this.repository = repository;
    this.revocations = revocations;
    this.matchingOrchestrator = matchingOrchestrator;
  }

  public async admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission> {
    const revokedAuthorityRefs =
      await this.revocations.listRevokedAuthorityRefs(
        request.institutionId,
        request.agentDid,
      );

    // Boundbuyer-style W3C VC path: when the request carries a
    // `delegationCredential`, route it through the boundbuyer
    // verifier instead of the JCS proof. The two paths are mutually
    // exclusive — exactly one of `authorityProof` or
    // `delegationCredential` is expected on a well-formed request.
    if (request.delegationCredential !== undefined && request.delegationCredential !== null) {
      if (!this.authorization.verifyBoundbuyerAuthority) {
        throw new PublicError(
          "service_unavailable",
          503,
          "Boundbuyer-style delegation credentials are not enabled on this server.",
        );
      }
      const verification = await this.authorization.verifyBoundbuyerAuthority({
        credential: request.delegationCredential as BoundbuyerDelegationCredential,
        institutionId: request.institutionId,
        agentDid: request.agentDid,
        requestedAction: "agent.admit",
        revokedAuthorityRefs,
      });

      if (verification.status !== "verified") {
        throw new PublicError("authorization_failed", 403);
      }

      return this.persistAdmittedAgent({
        request,
        authorityRef: verification.authorityRef,
        policyHash: verification.policyHash,
      });
    }

    // JCS proof path (the original flow).
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

    return this.persistAdmittedAgent({
      request,
      authorityRef: verification.authorityRef,
      policyHash: verification.policyHash,
    });
  }

  /**
   * Shared persistence path for both admit flows. Writes the agent
   * record with the authority limits and returns the public
   * `AgentAdmission` shape.
   */
  private async persistAdmittedAgent(input: {
    request: AdmitAgentRequest;
    authorityRef: string;
    policyHash: string;
  }): Promise<AgentAdmission> {
    const { request, authorityRef, policyHash } = input;
    const agent = await this.repository.create({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityRef,
      instrumentScope: request.limits?.instrumentScope ?? null,
      directionScope: request.limits?.directionScope ?? null,
      maxNotional: request.limits?.maxNotional ?? null,
      limitReference: request.limits?.limitReference ?? null,
      policyHash,
    });

    return {
      id: agent.id,
      agentDid: agent.agentDid,
      status: "admitted",
      authorityRef: agent.authorityRef,
      ...(agent.instrumentScope
        ? {
            limits: {
              instrumentScope: agent.instrumentScope,
              directionScope: (agent.directionScope ?? ["buy", "sell"]) as DirectionScope[],
              maxNotional: agent.maxNotional ?? "0",
              limitReference: agent.limitReference ?? "",
              policyHash: agent.policyHash ?? "",
            },
          }
        : {}),
    };
  }

  public async listAgents(
    institutionId: string,
    status?: AgentStatus,
  ): Promise<Agent[]> {
    return this.repository.listByInstitution(institutionId, status);
  }

  public async getAgent(
    id: string,
    institutionId: string,
  ): Promise<Agent> {
    const agent = await this.repository.findById(id, institutionId);
    if (!agent) {
      throw new PublicError("not_found", 404);
    }
    return agent;
  }

  public async updateAgentLabel(
    id: string,
    institutionId: string,
    label: string,
  ): Promise<Agent> {
    const agent = await this.repository.findById(id, institutionId);
    if (!agent) {
      throw new PublicError("not_found", 404);
    }
    await this.repository.updateLabel(id, label);
    return { ...agent, label };
  }

  public async revokeAgent(id: string, institutionId: string): Promise<void> {
    // Find the agent to get its agentDid for cascade operations
    const agents = await this.repository.listByInstitution(institutionId);
    const agent = agents.find((a) => a.id === id);

    if (!agent) {
      throw new PublicError("not_found", 404);
    }

    // Revoke in the database
    await this.repository.revoke(id);

    // Cascade: clear any pending intents from the matching orchestrator
    if (this.matchingOrchestrator) {
      this.matchingOrchestrator.removeIntentsByAgent(agent.agentDid, institutionId);
    }
  }
}
