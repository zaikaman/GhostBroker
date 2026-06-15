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
    console.log("[ADMIT.SERVICE] admitAgent called, delegationCredential:", request.delegationCredential === undefined ? "absent" : "present");
    const revokedAuthorityRefs =
      await this.revocations.listRevokedAuthorityRefs(
        request.institutionId,
        request.agentDid,
      );

    // Ghostbroker-only path. The JCS Smart-VC verifier is gone —
    // the live T3N onboarding surface only issues Ghostbroker-style
    // W3C credentials. The credential is persisted on the agent
    // record so submit / cancel / settlement can re-verify it.
    //
    // Post-Phase 1: the agent process no longer sends the
    // delegation VC inline (the backend owns it). When the
    // request does not carry a VC, we look up the agent record
    // by DID and load the persisted credential. This supports
    // both the dashboard's "Configure Agent" → "Admit" flow
    // and the Phase 2.5 demo orchestrator (which configures
    // agents before spawning the child processes).
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

    // When delegationCredential is still undefined (no inline VC,
    // no persisted VC — e.g. direct agent run without the demo
    // orchestrator or the dashboard Configure Agent flow), fall
    // back to a sandbox admit in development mode. The agent is
    // already authenticated via API key and scoped to the
    // institution; the sandbox authority ref lets the admit
    // complete so the agent can submit intents. In live mode
    // this path rejects with 403.
    if (!delegationCredential) {
      return this.sandboxAdmit({
        request,
      });
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

    // Check if the agent record already exists (loaded from the
    // VC lookup above). If so, return the existing admission
    // rather than attempting a duplicate insert — the agents
    // table has a unique constraint on (institution_id, agent_did).
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
  /**
   * Sandbox admit path for agents that run without a delegation
   * VC (e.g. direct `npm run buyer` without the demo orchestrator
   * or dashboard Configure Agent flow). Generates a synthetic
   * authority ref and admits the agent so it can submit intents.
   *
   * This is safe because the agent is already authenticated via
   * API key (scoped to a specific institution). The sandbox mode
   * is the default when `VC_VERIFY_MODE` is not set to `live`.
   * In live production, this path throws 403 to enforce the
   * delegation VC requirement.
   */
  private async sandboxAdmit(input: {
    request: AdmitAgentRequest;
  }): Promise<AgentAdmission> {
    const { request } = input;

    // Only allow sandbox admit in non-live environments. The
    // mode is read from the env var (same convention as
    // `verifyGhostbrokerDelegationCredential`).
    const mode = (process.env.VC_VERIFY_MODE ?? "sandbox").trim().toLowerCase();
    if (mode === "live") {
      throw new PublicError("authorization_failed", 403);
    }

    // Check if the agent already exists (e.g. a previous
    // sandbox admit created the record). The agents table has
    // a unique constraint on (institution_id, agent_did), so
    // we must return the existing admission rather than
    // attempting a duplicate insert.
    const existing = await this.repository.findByAgentDid(
      request.institutionId,
      request.agentDid,
    );
    console.log(
      "[SANDBOX]",
      "did:", request.agentDid.slice(0, 30),
      "existing:", existing ? existing.id : "null",
    );
    if (existing) {
      return {
        id: existing.id,
        agentDid: existing.agentDid,
        status: "admitted",
        authorityRef: existing.authorityRef,
      };
    }

    const agent = await this.repository.create({
      institutionId: request.institutionId,
      agentDid: request.agentDid,
      authorityRef: `ghostbroker-delegation:sandbox-admit-${cryptoRandomHex(16)}`,
      instrumentScope: request.limits?.instrumentScope ?? null,
      directionScope: request.limits?.directionScope ?? null,
      maxNotional: request.limits?.maxNotional ?? null,
      limitReference: request.limits?.limitReference ?? null,
      policyHash: cryptoRandomHex(32),
    });

    return {
      id: agent.id,
      agentDid: agent.agentDid,
      status: "admitted",
      authorityRef: agent.authorityRef,
    };
  }

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
