import { PublicError } from "../errors/public-error.js";

interface AuthorityRevocationRecord {
  authority_ref: string;
}

interface AuthorityRevocationSelectQuery {
  eq(column: string, value: string): AuthorityRevocationSelectQuery;
  is(column: string, value: null): Promise<{
    data: AuthorityRevocationRecord[] | null;
    error: Error | null;
  }>;
}

interface AuthorityRevocationTableQuery {
  select(columns?: string): AuthorityRevocationSelectQuery;
}

export interface AuthorityRevocationRepository {
  listRevokedAuthorityRefs(
    institutionId: string,
    agentDid: string,
  ): Promise<ReadonlySet<string>>;
}

export interface SupabaseAuthorityRevocationClient {
  from(table: "agent_authority_revocations"): AuthorityRevocationTableQuery;
}

export class SupabaseAuthorityRevocationRepository
  implements AuthorityRevocationRepository
{
  private readonly client: SupabaseAuthorityRevocationClient;

  public constructor(client: SupabaseAuthorityRevocationClient) {
    this.client = client;
  }

  public async listRevokedAuthorityRefs(
    institutionId: string,
    agentDid: string,
  ): Promise<ReadonlySet<string>> {
    const { data, error } = await this.client
      .from("agent_authority_revocations")
      .select("authority_ref")
      .eq("institution_id", institutionId)
      .eq("agent_did", agentDid)
      .is("unrevoked_at", null);

    if (error || !data) {
      throw new PublicError("authorization_failed", 403, error);
    }

    return new Set(data.map((record) => record.authority_ref));
  }
}

export class EmptyAuthorityRevocationRepository
  implements AuthorityRevocationRepository
{
  public async listRevokedAuthorityRefs(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}
