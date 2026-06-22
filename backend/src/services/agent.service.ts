import { PublicError } from "../errors/public-error.js";
import type { AgentAuthorizationFacade } from "../auth/agent-authz.js";
import type {
  AdmitAgentRequest,
  AgentAdmission,
  Agent,
  AgentStatus,
  DirectionScope,
} from "../models/agent.js";
import type { NegotiationMandateInput } from "../models/negotiation.js";
import type { AgentRepository } from "./agent-repository.js";
import {
  EmptyAuthorityRevocationRepository,
  type AuthorityRevocationRepository,
} from "./authority-revocation.service.js";
import type { MatchingOrchestrator } from "./matching-orchestrator.js";
import type { DelegationCredential } from "../sdk/agent-client/index.js";
import type { DelegationActionScope } from "../enclave/index.js";
import type { SdkDelegationEnvelope } from "../enclave/auth/sdk-delegation-signer.js";

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
  updateAgentMetadata?(input: {
    id: string;
    institutionId: string;
    patch: Record<string, unknown>;
  }): Promise<Agent>;
  revokeAgent(id: string, institutionId: string): Promise<void>;
  /**
   * Persist a freshly-signed delegation VC on the agent's
   * `metadata.delegation_credential` column. The
   * `authorityRef` stored on the agent record is also updated
   * so future `loadAndVerify` calls return the right id.
   * Returns the updated agent record.
   */
  persistDelegation(input: {
    agentId: string;
    institutionId: string;
    credential: DelegationCredential;
    policyHash: string;
    sdkEnvelope?: SdkDelegationEnvelope;
  }): Promise<Agent>;
  /**
   * Look up the persisted delegation VC for an agent. Returns
   * `null` when the agent has no VC yet (e.g. a freshly-created
   * agent record pre-admit). The facade uses this on every
   * privileged call so the agent never has to send the VC.
   */
  loadDelegationCredential(input: {
    agentId: string;
    institutionId: string;
  }): Promise<DelegationCredential | null>;
  /**
   * Phase 1 step 4 + Phase 2.5: the "Configure Agent"
   * entrypoint. Mints a fresh agent DID (or accepts one
   * from the dashboard), signs a tenant VC for the
   * policy the dashboard collected, and persists the
   * agent record with the VC in metadata. The agent
   * process later calls `POST /api/agents/admit` with
   * the same `agentDid`; the backend's `loadAndVerify`
   * facade looks the VC up by `agentId` and re-verifies
   * on every privileged call.
   *
   * Returns the new agent record and the policy hash
   * the verifier will produce.
   */
  configureAgent(input: {
    institutionId: string;
    agentDid: string;
    label?: string;
    policy: {
      maxSpendUsd: number;
      allowedActions: readonly DelegationActionScope[];
      approverEmail?: string;
      purpose?: string;
      mandate?: NegotiationMandateInput;
      validityMonths?: number;
    };
    /**
     * Callback that signs the VC. The backend owns the
     * tenant signer; tests inject a stub. Keeps the
     * `tenant-delegation-signer` import out of the
     * service's transitive dependency surface.
     */
    signCredential: (input: {
      agentDid: string;
      institutionId: string;
      maxSpendUsd: number;
      allowedActions: readonly DelegationActionScope[];
      approverEmail?: string;
      purpose?: string;
      mandate?: NegotiationMandateInput;
      validityMonths?: number;
    }) => Promise<{ credential: DelegationCredential; policyHash: string; sdkEnvelope?: SdkDelegationEnvelope }>;
  }): Promise<{ agent: Agent; policyHash: string }>;
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

    let delegationCredential = request.delegationCredential;
    if (!delegationCredential) {
      const existingAgent = await this.repository.findByAgentDid(
        request.institutionId,
        request.agentDid,
      );
      if (existingAgent) {
        const persistedVc = (
          existingAgent.metadata as Record<string, unknown> | null
        )?.delegation_credential;
        if (persistedVc) {
          delegationCredential = persistedVc;
        }
      }
    }

    if (!delegationCredential) {
      throw new PublicError(
        "authorization_failed",
        403,
        "admitAgent: no delegation credential supplied and no persisted VC found for the agent DID. Run the dashboard 'Configure Agent' flow to mint + persist a signed W3C VC before admitting.",
      );
    }

    const verification = await this.authorization.verifyAgentAuthority({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityRef: "",
      delegationCredential,
      requestedAction: "agent.admit",
      revokedAuthorityRefs,
    });

    if (verification.status !== "verified") {
      throw new PublicError("authorization_failed", 403);
    }

    const alreadyAdmitted = await this.repository.findByAgentDid(
      request.institutionId,
      request.agentDid,
    );
    if (alreadyAdmitted) {
      return {
        id: alreadyAdmitted.id,
        agentDid: alreadyAdmitted.agentDid,
        status: "admitted",
        authorityRef: alreadyAdmitted.authorityRef,
      };
    }

    return this.persistAdmittedAgent({
      request,
      authorityRef: verification.authorityRef,
      policyHash: verification.policyHash,
      delegationCredential,
    });
  }

  /**
   * Shared persistence path for the admit flow. Writes the agent
   * record (with the Ghostbroker delegation VC stored in `metadata`) and
   * returns the public `AgentAdmission` shape.
   */

  private async persistAdmittedAgent(input: {
    request: AdmitAgentRequest;
    authorityRef: string;
    policyHash: string;
    delegationCredential?: unknown;
  }): Promise<AgentAdmission> {
    const { request, authorityRef, policyHash, delegationCredential } = input;
    const agent = await this.repository.create({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityRef,
      instrumentScope: request.limits?.instrumentScope ?? null,
      directionScope: request.limits?.directionScope ?? null,
      maxNotional: request.limits?.maxNotional ?? null,
      limitReference: request.limits?.limitReference ?? null,
      policyHash,
      delegationCredential,
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

  public async updateAgentMetadata(input: {
    id: string;
    institutionId: string;
    patch: Record<string, unknown>;
  }): Promise<Agent> {
    const agent = await this.repository.findById(input.id, input.institutionId);
    if (!agent) {
      throw new PublicError("not_found", 404);
    }
    return this.repository.updateMetadata(input.id, input.patch);
  }

  public async revokeAgent(id: string, institutionId: string): Promise<void> {
    // Find the agent to get its agentDid for cascade operations
    const agents = await this.repository.listByInstitution(institutionId);
    const agent = agents.find((a) => a.id === id);

    if (!agent) {
      throw new PublicError("not_found", 404);
    }

    // Load the SDK delegation envelope from the agent's
    // metadata (persisted at configure time by the SDK-native
    // minting path). When present, the revocation service
    // performs on-chain revocation via `revokeDelegation` in
    // addition to the database-side revocation.
    const sdkEnvelope = (
      agent.metadata as Record<string, unknown> | null
    )?.sdk_delegation_envelope as SdkDelegationEnvelope | undefined;

    // Revoke on-chain (if SDK envelope + T3nClient available)
    // and in the database. The revocation service delegates the
    // Supabase-side record write and adds the on-chain step
    // best-effort.
    await this.revocations.revokeAuthority({
      institutionId,
      agentDid: agent.agentDid,
      agentId: id,
      ...(sdkEnvelope ? { sdkEnvelope } : {}),
    });

    // Revoke in the database
    await this.repository.revoke(id);

    // Cascade: clear any pending intents from the matching orchestrator
    if (this.matchingOrchestrator) {
      this.matchingOrchestrator.removeIntentsByAgent(agent.agentDid, institutionId);
    }
  }

  public async persistDelegation(input: {
    agentId: string;
    institutionId: string;
    credential: DelegationCredential;
    policyHash: string;
    sdkEnvelope?: SdkDelegationEnvelope;
  }): Promise<Agent> {
    const existing = await this.repository.findById(
      input.agentId,
      input.institutionId,
    );
    if (!existing) {
      throw new PublicError("not_found", 404);
    }
    // Two writes: metadata (the VC + optional SDK envelope) and
    // authority_ref (the verifier's authorityRef). Both are needed
    // because the verifier computes authorityRef from `credential.id`,
    // and the agent record's `authority_ref` column is the
    // public-facing id the agent process echoes back.
    //
    // The SDK delegation envelope is persisted alongside the VC so
    // the on-chain revocation path (SdkAuthorityRevocationRepository)
    // has access to the JCS-canonicalised credential bytes and function
    // list needed for revokeDelegation.
    const authorityRef = `ghostbroker-delegation:${input.credential.id}`;
    const metadata: Record<string, unknown> = {
      delegation_credential: input.credential,
    };
    if (input.sdkEnvelope) {
      metadata.sdk_delegation_envelope = input.sdkEnvelope;
    }
    const withMeta = await this.repository.updateMetadata(input.agentId, metadata);
    return this.repository.updateAuthorityRef({
      id: input.agentId,
      authorityRef,
      policyHash: input.policyHash,
    }).then((updated) => updated ?? withMeta);
  }

  public async loadDelegationCredential(input: {
    agentId: string;
    institutionId: string;
  }): Promise<DelegationCredential | null> {
    const agent = await this.repository.findById(
      input.agentId,
      input.institutionId,
    );
    if (!agent) {
      return null;
    }
    const vc = (agent.metadata as Record<string, unknown> | null)
      ?.delegation_credential;
    if (vc && typeof vc === "object") {
      return vc as DelegationCredential;
    }
    return null;
  }

  public async configureAgent(input: {
    institutionId: string;
    agentDid: string;
    label?: string;
    policy: {
      maxSpendUsd: number;
      allowedActions: readonly DelegationActionScope[];
      approverEmail?: string;
      purpose?: string;
      mandate?: NegotiationMandateInput;
      validityMonths?: number;
    };
    signCredential: (input: {
      agentDid: string;
      institutionId: string;
      maxSpendUsd: number;
      allowedActions: readonly DelegationActionScope[];
      approverEmail?: string;
      purpose?: string;
      mandate?: NegotiationMandateInput;
      validityMonths?: number;
    }) => Promise<{ credential: DelegationCredential; policyHash: string; sdkEnvelope?: SdkDelegationEnvelope }>;
  }): Promise<{ agent: Agent; policyHash: string }> {
    // The agent DID is the secp256k1-derived DID the dashboard
    // minted in the browser (`did:t3n:0x<eth-address>`). The
    // dashboard holds the matching private keypair; the backend's
    // tenant signer binds the delegation VC to this DID. The
    // previous `did:t3n:demo-<random>` backend-minted fallback
    // has been removed because it let any caller create an
    // admission without holding a keypair.
    const agentDid = input.agentDid;

    const { credential, policyHash, sdkEnvelope } = await input.signCredential({
      agentDid,
      institutionId: input.institutionId,
      maxSpendUsd: input.policy.maxSpendUsd,
      allowedActions: input.policy.allowedActions,
      ...(input.policy.approverEmail
        ? { approverEmail: input.policy.approverEmail }
        : {}),
      ...(input.policy.purpose ? { purpose: input.policy.purpose } : {}),
      ...(input.policy.mandate ? { mandate: input.policy.mandate } : {}),
      ...(input.policy.validityMonths
        ? { validityMonths: input.policy.validityMonths }
        : {}),
    });

    const authorityRef = `ghostbroker-delegation:${credential.id}`;
    const agent = await this.repository.create({
      institutionId: input.institutionId,
      agentDid,
      authorityRef,
      label: input.label ?? null,
      policyHash,
      delegationCredential: credential,
      sdkDelegationEnvelope: sdkEnvelope,
    });

    return { agent, policyHash };
  }
}

