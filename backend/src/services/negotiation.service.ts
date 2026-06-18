import { PublicError } from "../errors/public-error.js";
import type {
  NegotiationMove,
  NegotiationSessionRecord,
  RedactedNegotiationSessionView,
  NegotiationMandate,
  NegotiationMandateInput,
  AuthoredMandatePolicyInput,
  CreateNegotiationMandateRequest,
} from "../models/negotiation.js";
import type { AgentManagementService } from "./agent.service.js";
import type {
  NegotiationOrchestrator,
} from "./negotiation-orchestrator.js";
import type { TenantDelegationSigner } from "./tenant-delegation-signer.js";
import type {
  NegotiationRepository,
} from "./negotiation-repository.js";
import type { DelegationCredential } from "@ghostbroker/agent-client";
import {
  normalizeStrategy,
  type AuthoredMandatePolicy,
  type DerivedExecutionRails,
} from "./negotiation-strategy.js";

export interface NegotiationManagementService {
  createMandate(input: {
    institutionId: string;
    agentId: string;
    request: CreateNegotiationMandateRequest;
  }): Promise<{
    mandate: NegotiationMandate;
    authorityRef: string;
    policyHash: string;
  }>;
  getMandateByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate | null>;
  listMandatesByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate[]>;
  getMandate(
    institutionId: string,
    mandateId: string,
  ): Promise<NegotiationMandate>;
  submitTicket(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    authorityRef: string;
    assetCode: string;
    side: "buy" | "sell";
    compatibilityToken: string;
    correlationRef: string;
  }): Promise<{ ticketHandle: string; sessionId: string | null }>;
  submitMove(input: {
    institutionId: string;
    sessionId: string;
    agentId: string;
    agentDid: string;
    authorityRef: string;
    move: NegotiationMove;
    claimCredential?: unknown;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }>;
  approveEscalation(input: {
    institutionId: string;
    sessionId: string;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }>;
  declineEscalation(input: {
    institutionId: string;
    sessionId: string;
    reason?: string;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }>;
  listSessions(
    institutionId: string,
    agentDid?: string,
  ): Promise<RedactedNegotiationSessionView[]>;
  getSession(
    institutionId: string,
    sessionId: string,
  ): Promise<RedactedNegotiationSessionView>;
}

function authorityRefFor(credential: DelegationCredential): string {
  return `ghostbroker-delegation:${credential.id}`;
}

export class NegotiationService implements NegotiationManagementService {
  private readonly repository: NegotiationRepository;
  private readonly agentService: AgentManagementService;
  private readonly tenantSigner: TenantDelegationSigner;
  private readonly orchestrator: NegotiationOrchestrator;

  public constructor(input: {
    repository: NegotiationRepository;
    agentService: AgentManagementService;
    tenantSigner: TenantDelegationSigner;
    orchestrator: NegotiationOrchestrator;
  }) {
    this.repository = input.repository;
    this.agentService = input.agentService;
    this.tenantSigner = input.tenantSigner;
    this.orchestrator = input.orchestrator;
  }

  public async createMandate(input: {
    institutionId: string;
    agentId: string;
    request: CreateNegotiationMandateRequest;
  }): Promise<{
    mandate: NegotiationMandate;
    authorityRef: string;
    policyHash: string;
  }> {
    const agent = await this.agentService.getAgent(
      input.agentId,
      input.institutionId,
    );

    const { authored, rails, legacy } = this.resolveMandatePayload(input.request);

    const policy = {
      agentDid: agent.agentDid,
      institutionId: agent.institutionId,
      maxSpendUsd: 1,
      allowedCategories: ["services"] as ("office-supplies" | "software" | "hardware" | "services" | "travel")[],
      mandate: (authored ?? legacy) as NegotiationMandateInput,
    };

    const { credential, policyHash } = await this.tenantSigner.mint(policy);

    await this.agentService.persistDelegation({
      agentId: agent.id,
      institutionId: agent.institutionId,
      credential,
      policyHash,
    });

    const mandate = await this.repository.createMandate({
      institutionId: input.institutionId,
      agentId: agent.id,
      agentDid: agent.agentDid,
      policyHash,
      ...(authored ? { authored, rails } : {}),
      ...(legacy ? { legacy } : {}),
    });

    return {
      mandate,
      authorityRef: authorityRefFor(credential),
      policyHash,
    };
  }

  /**
   * Resolve the persisted mandate payload from the create request.
   * Authored policy is primary; the derived rails are computed from
   * it. Legacy derived-flavored input is passed through unchanged.
   */
  private resolveMandatePayload(request: CreateNegotiationMandateRequest): {
    authored?: AuthoredMandatePolicy;
    rails?: DerivedExecutionRails;
    legacy?: NegotiationMandateInput;
  } {
    if (request.authored) {
      const profile = normalizeStrategy(request.authored satisfies AuthoredMandatePolicyInput as AuthoredMandatePolicy);
      return { authored: profile.authored, rails: profile.rails };
    }
    if (request.mandate) {
      return { legacy: request.mandate };
    }
    throw new PublicError(
      "validation_failed",
      400,
      undefined,
      "Either an authored policy or a legacy mandate is required.",
    );
  }

  public async getMandateByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate | null> {
    return this.repository.getMandateByAgent(institutionId, agentId);
  }

  public async listMandatesByAgent(
    institutionId: string,
    agentId: string,
  ): Promise<NegotiationMandate[]> {
    return this.repository.listMandatesByAgent(institutionId, agentId);
  }

  public async getMandate(
    institutionId: string,
    mandateId: string,
  ): Promise<NegotiationMandate> {
    const mandate = await this.repository.getMandateById(mandateId, institutionId);
    if (!mandate) {
      throw new PublicError("not_found", 404);
    }
    return mandate;
  }

  public async submitTicket(input: {
    institutionId: string;
    agentId: string;
    agentDid: string;
    authorityRef: string;
    assetCode: string;
    side: "buy" | "sell";
    compatibilityToken: string;
    correlationRef: string;
  }): Promise<{ ticketHandle: string; sessionId: string | null }> {
    return this.orchestrator.submitTicket(input);
  }

  public async submitMove(input: {
    institutionId: string;
    sessionId: string;
    agentId: string;
    agentDid: string;
    authorityRef: string;
    move: NegotiationMove;
    claimCredential?: unknown;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    return this.orchestrator.submitMove(input);
  }

  public async approveEscalation(input: {
    institutionId: string;
    sessionId: string;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    return this.orchestrator.approveEscalation(input);
  }

  public async declineEscalation(input: {
    institutionId: string;
    sessionId: string;
    reason?: string;
    correlationRef: string;
  }): Promise<{ status: NegotiationSessionRecord["status"] }> {
    return this.orchestrator.declineEscalation(input);
  }

  public async listSessions(
    institutionId: string,
    agentDid?: string,
  ): Promise<RedactedNegotiationSessionView[]> {
    return this.repository.listSessions(institutionId, agentDid);
  }

  public async getSession(
    institutionId: string,
    sessionId: string,
  ): Promise<RedactedNegotiationSessionView> {
    const session = await this.repository.getSession(sessionId, institutionId);
    if (!session) {
      throw new PublicError("not_found", 404);
    }
    return session;
  }
}
