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
    }> & {
      select(columns?: string): {
        single(): Promise<{ data: AgentRecord | null; error: Error | null }>;
      };
    };
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
    /**
     * The SDK-native delegation envelope (JCS bytes + EIP-191
     * signature + agent invocation keypair) for on-chain
     * revocation via `revokeDelegation`. Stored alongside the
     * W3C VC in agent metadata so the revocation path has
     * access to the canonicalised credential bytes.
     */
    sdkDelegationEnvelope?: unknown;
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
  /**
   * Patch the agent's `metadata` JSONB column. Used by the
   * server-side delegation signer to persist the W3C VC on
   * the agent record at admit time, and to re-persist a
   * freshly minted VC on the "Regenerate Delegation" path.
   * Merges into the existing metadata object — does not
   * overwrite the whole column.
   */
  updateMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Agent>;
  /**
   * Update the `authority_ref` / `policy_hash` columns. Used
   * together with `updateMetadata` when a re-mint produces
   * a new VC id; the columns need to track the new id so
   * the verifier's `authorityRef` check still lines up.
   */
  updateAuthorityRef(input: {
    id: string;
    authorityRef: string;
    policyHash: string;
  }): Promise<Agent>;
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
    sdkDelegationEnvelope?: unknown;
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
          ...(params.sdkDelegationEnvelope !== undefined
            ? { sdk_delegation_envelope: params.sdkDelegationEnvelope }
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

  public async updateMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Agent> {
    // Read-merge-write. The JSONB column is small (one VC
    // + a few operator-set fields) and the merge keeps the
    // interface local — no need to add a Supabase RPC for
    // a single-writer hot path that fires once per agent
    // per re-mint.
    const existing = await this.client
      .from("agents")
      .select("*")
      .eq("id", id)
      .single();
    if (existing.error || !existing.data) {
      throw new PublicError("not_found", 404);
    }
    const merged = {
      ...(existing.data.metadata ?? {}),
      ...patch,
    };
    const { data, error } = await this.client
      .from("agents")
      .update({ metadata: merged })
      .eq("id", id)
      .select("*")
      .single();
    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }
    return agentFromRecord(data);
  }

  public async updateAuthorityRef(input: {
    id: string;
    authorityRef: string;
    policyHash: string;
  }): Promise<Agent> {
    const { data, error } = await this.client
      .from("agents")
      .update({
        authority_ref: input.authorityRef,
        policy_hash: input.policyHash,
      })
      .eq("id", input.id)
      .select("*")
      .single();
    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }
    return agentFromRecord(data);
  }
}
