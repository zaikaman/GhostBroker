import { PublicError } from "../errors/public-error.js";
import { randomBytes } from "node:crypto";
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
import type { DelegationCredential } from "@ghostbroker/agent-client";

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
    agentDid?: string;
    label?: string;
    policy: {
      maxSpendUsd: number;
      allowedCategories: ReadonlyArray<
        "office-supplies" | "software" | "hardware" | "services" | "travel"
      >;
      approverEmail?: string;
      purpose?: string;
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
      allowedCategories: ReadonlyArray<
        "office-supplies" | "software" | "hardware" | "services" | "travel"
      >;
      approverEmail?: string;
      purpose?: string;
      validityMonths?: number;
    }) => Promise<{ credential: DelegationCredential; policyHash: string }>;
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

    // Ghostbroker-only path. The JCS Smart-VC verifier is gone —
    // the live T3N onboarding surface only issues Ghostbroker-style
    // W3C credentials. The credential is persisted on the agent
    // record so submit / cancel / settlement can re-verify it.
    const verification = await this.authorization.verifyAgentAuthority({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityRef: "",
      delegationCredential: request.delegationCredential,
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
   * Shared persistence path for the admit flow. Writes the agent
   * record (with the Ghostbroker delegation VC stored in `metadata`) and
   * returns the public `AgentAdmission` shape.
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
      delegationCredential: request.delegationCredential,
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

  public async persistDelegation(input: {
    agentId: string;
    institutionId: string;
    credential: DelegationCredential;
    policyHash: string;
  }): Promise<Agent> {
    const existing = await this.repository.findById(
      input.agentId,
      input.institutionId,
    );
    if (!existing) {
      throw new PublicError("not_found", 404);
    }
    // Two writes: metadata (the VC) and authority_ref (the
    // verifier's authorityRef). Both are needed because the
    // verifier computes authorityRef from `credential.id`,
    // and the agent record's `authority_ref` column is the
    // public-facing id the agent process echoes back.
    const authorityRef = `ghostbroker-delegation:${input.credential.id}`;
    const withMeta = await this.repository.updateMetadata(input.agentId, {
      delegation_credential: input.credential,
    });
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
    agentDid?: string;
    label?: string;
    policy: {
      maxSpendUsd: number;
      allowedCategories: ReadonlyArray<
        "office-supplies" | "software" | "hardware" | "services" | "travel"
      >;
      approverEmail?: string;
      purpose?: string;
      validityMonths?: number;
    };
    signCredential: (input: {
      agentDid: string;
      institutionId: string;
      maxSpendUsd: number;
      allowedCategories: ReadonlyArray<
        "office-supplies" | "software" | "hardware" | "services" | "travel"
      >;
      approverEmail?: string;
      purpose?: string;
      validityMonths?: number;
    }) => Promise<{ credential: DelegationCredential; policyHash: string }>;
  }): Promise<{ agent: Agent; policyHash: string }> {
    // The agent DID is either the one the dashboard
    // minted client-side, or a synthetic
    // `did:t3n:demo-<random>` placeholder minted by the
    // backend for the demo orchestrator path. The agent
    // process re-uses this exact DID on its admit call.
    const agentDid =
      input.agentDid ?? `did:t3n:demo-${cryptoRandomHex(24)}`;

    const { credential, policyHash } = await input.signCredential({
      agentDid,
      institutionId: input.institutionId,
      maxSpendUsd: input.policy.maxSpendUsd,
      allowedCategories: input.policy.allowedCategories,
      ...(input.policy.approverEmail
        ? { approverEmail: input.policy.approverEmail }
        : {}),
      ...(input.policy.purpose ? { purpose: input.policy.purpose } : {}),
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
    });

    return { agent, policyHash };
  }
}

/**
 * Generate a short random hex string. The T3N DID
 * convention is `did:t3n:<identifier>`; for the demo
 * orchestrator path we mint a synthetic identifier
 * derived from `randomBytes(12)` (24 hex chars). 48
 * bits of entropy is enough to disambiguate concurrent
 * demo runs on the same institution.
 */
function cryptoRandomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}
