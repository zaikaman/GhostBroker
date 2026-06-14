import { PublicError } from "../errors/public-error.js";
import {
  type AgentRecord,
  type AgentStatus,
  type Agent,
  agentFromRecord,
} from "../models/agent.js";

// ─── Supabase Query Type Declarations ────────────────────────────────────

interface InsertResult<TResult> {
  single(): Promise<{ data: TResult | null; error: Error | null }>;
}

interface QueryChain<TResult> {
  eq(column: string, value: string): QueryChain<TResult>;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): Promise<{ data: TResult[] | null; error: Error | null }>;
  single(): Promise<{ data: TResult | null; error: Error | null }>;
}

interface InsertQuery<TResult> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): InsertResult<TResult>;
  };
}

interface SelectQuery<TResult> {
  select(columns?: string): QueryChain<TResult>;
}

interface UpdateQuery {
  update(value: Record<string, unknown>): {
    eq(column: string, value: string): Promise<{
      data: unknown;
      error: Error | null;
    }>;
  };
}

interface SupabaseAgentClient {
  from(table: "agents"): InsertQuery<AgentRecord> &
    SelectQuery<AgentRecord> &
    UpdateQuery;
}

// ─── Repository ──────────────────────────────────────────────────────────

export interface AgentRepository {
  create(params: {
    institutionId: string;
    agentDid: string;
    authorityRef: string;
    label?: string | null;
    instrumentScope?: string[] | null;
    directionScope?: string[] | null;
    maxNotional?: string | null;
    limitReference?: string | null;
    policyHash?: string | null;
    /**
     * The Ghostbroker delegation W3C VC, persisted so the intent submit /
     * cancel / settlement paths can re-verify it on every
     * privileged action without the agent having to resend it.
     */
    delegationCredential?: unknown;
  }): Promise<Agent>;
  listByInstitution(
    institutionId: string,
    status?: AgentStatus,
  ): Promise<Agent[]>;
  findById(id: string, institutionId: string): Promise<Agent | null>;
  updateLabel(id: string, label: string): Promise<void>;
  revoke(id: string): Promise<void>;
  findByAgentDid(
    institutionId: string,
    agentDid: string,
  ): Promise<Agent | null>;
}

export class SupabaseAgentRepository implements AgentRepository {
  private readonly client: SupabaseAgentClient;

  public constructor(client: SupabaseAgentClient) {
    this.client = client;
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
    const { data, error } = await this.client
      .from("agents")
      .insert({
        institution_id: params.institutionId,
        agent_did: params.agentDid,
        authority_ref: params.authorityRef,
        status: "admitted",
        label: params.label ?? null,
        instrument_scope: params.instrumentScope ?? null,
        direction_scope: params.directionScope ?? null,
        max_notional: params.maxNotional ?? null,
        limit_reference: params.limitReference ?? null,
        policy_hash: params.policyHash ?? null,
        metadata: {
          ...(params.delegationCredential !== undefined
            ? { delegation_credential: params.delegationCredential }
            : {}),
        },
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return agentFromRecord(data);
  }

  public async listByInstitution(
    institutionId: string,
    status?: AgentStatus,
  ): Promise<Agent[]> {
    let query = this.client.from("agents").select("*").eq(
      "institution_id",
      institutionId,
    );

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error || !data) {
      return [];
    }

    return data.map(agentFromRecord);
  }

  public async findById(
    id: string,
    institutionId: string,
  ): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select("*")
      .eq("id", id)
      .eq("institution_id", institutionId)
      .single();

    if (error || !data) {
      return null;
    }

    return agentFromRecord(data);
  }

  public async updateLabel(id: string, label: string): Promise<void> {
    const { error } = await this.client
      .from("agents")
      .update({ label })
      .eq("id", id);

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
  }

  public async revoke(id: string): Promise<void> {
    const { error } = await this.client
      .from("agents")
      .update({ status: "revoked" })
      .eq("id", id);

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
  }

  public async findByAgentDid(
    institutionId: string,
    agentDid: string,
  ): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select("*")
      .eq("institution_id", institutionId)
      .eq("agent_did", agentDid)
      .single();

    if (error || !data) {
      return null;
    }

    return agentFromRecord(data);
  }
}
