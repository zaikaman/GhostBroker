import type { Agent, AgentStatus } from "../../models/agent.js";
import type { AgentRepository } from "../../services/agent-repository.js";

/**
 * In-memory fake AgentRepository for unit/integration tests
 * that don't need real Supabase connectivity.
 *
 * By default, any `findByAgentDid` lookup for an agent that has
 * not been pre-registered returns a synthetic agent with a
 * placeholder delegation VC in metadata. That keeps the
 * submit-time null check in `HiddenIntentService.submitIntent`
 * satisfied without requiring every test to register agents
 * explicitly. Tests that need to exercise the missing-agent
 * path can call `disableAutoRegister()`.
 */
export class FakeAgentRepository implements AgentRepository {
  private readonly agents: Agent[] = [];
  private nextId = 1;
  private autoRegister = true;

  public disableAutoRegister(): void {
    this.autoRegister = false;
  }

  public async create(params: {
    institutionId: string;
    agentDid: string;
    authorityRef: string;
    label?: string | null;
    instrumentScope?: string[] | null;
    directionScope?: string[] | null;
    maxNotional?: string | null;
    limitReference?: string | null;
    policyHash?: string | null;
    delegationCredential?: unknown;
  }): Promise<Agent> {
    const id = `test-agent-${this.nextId++}`;
    const now = new Date().toISOString();
    const agent: Agent = {
      id,
      institutionId: params.institutionId,
      agentDid: params.agentDid,
      status: "admitted",
      authorityRef: params.authorityRef,
      label: params.label ?? null,
      instrumentScope: params.instrumentScope ?? null,
      directionScope: params.directionScope ?? null,
      maxNotional: params.maxNotional ?? null,
      limitReference: params.limitReference ?? null,
      policyHash: params.policyHash ?? null,
      metadata:
        params.delegationCredential !== undefined
          ? { delegation_credential: params.delegationCredential }
          : {},
      createdAt: now,
      updatedAt: now,
    };
    this.agents.push(agent);
    return agent;
  }

  public async listByInstitution(
    institutionId: string,
    status?: AgentStatus,
  ): Promise<Agent[]> {
    let results = this.agents.filter(
      (a) => a.institutionId === institutionId,
    );
    if (status) {
      results = results.filter((a) => a.status === status);
    }
    return results.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  public async findById(
    id: string,
    institutionId: string,
  ): Promise<Agent | null> {
    return (
      this.agents.find(
        (a) => a.id === id && a.institutionId === institutionId,
      ) ?? null
    );
  }

  public async updateLabel(id: string, label: string): Promise<void> {
    const agent = this.agents.find((a) => a.id === id);
    if (agent) {
      agent.label = label;
    }
  }

  public async revoke(id: string): Promise<void> {
    const agent = this.agents.find((a) => a.id === id);
    if (agent) {
      agent.status = "revoked";
    }
  }

  public async findByAgentDid(
    institutionId: string,
    agentDid: string,
  ): Promise<Agent | null> {
    const existing = this.agents.find(
      (a) => a.institutionId === institutionId && a.agentDid === agentDid,
    );
    if (existing) {
      return existing;
    }
    if (!this.autoRegister) {
      return null;
    }
    // Synthesize a placeholder agent so the submit-time VC
    // load check passes. The agent's `delegationCredential` is
    // a placeholder `{ id }` object that the verifier accepts
    // as "verified" when paired with a matching
    // `VerifiedAuthorization` stub (the test fakes don't run
    // the real verifier; they short-circuit on the authz
    // facade). Production never hits this path.
    return this.create({
      institutionId,
      agentDid,
      authorityRef: `authority:${agentDid}`,
      delegationCredential: { id: `vc-${agentDid}` },
    });
  }

  public async updateMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Agent> {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) {
      throw new Error(`agent ${id} not found`);
    }
    const next: Agent = {
      ...agent,
      metadata: { ...agent.metadata, ...patch } as Readonly<
        Record<string, unknown>
      >,
    };
    Object.assign(agent, next);
    return next;
  }

  public async updateAuthorityRef(input: {
    id: string;
    authorityRef: string;
    policyHash: string;
  }): Promise<Agent> {
    const agent = this.agents.find((a) => a.id === input.id);
    if (!agent) {
      throw new Error(`agent ${input.id} not found`);
    }
    const next: Agent = {
      ...agent,
      authorityRef: input.authorityRef,
      policyHash: input.policyHash,
    };
    Object.assign(agent, next);
    return next;
  }
}
