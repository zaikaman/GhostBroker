import { PublicError } from "../errors/public-error.js";
import {
  type ApiKey,
  type ApiKeyCreatedResponse,
  type ApiKeyRecord,
  apiKeyFromRecord,
  generateApiKey,
  hashApiKey,
} from "../models/api-key.js";

// ─── Supabase Query Type Declarations ────────────────────────────────────

interface InsertQuery<TResult> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): {
      single(): Promise<{ data: TResult | null; error: Error | null }>;
    };
  };
}

interface SelectQuery<TResult> {
  select(columns?: string): {
    eq(column: string, value: string): SelectClause<TResult>;
    is(column: string, value: null): SelectTerminal<TResult>;
  };
}

interface SelectClause<TResult> {
  is(column: string, value: null): SelectTerminal<TResult>;
  order(column: string, options?: { ascending?: boolean }): Promise<{
    data: TResult[] | null;
    error: Error | null;
  }>;
}

interface SelectTerminal<TResult> {
  order(column: string, options?: { ascending?: boolean }): Promise<{
    data: TResult[] | null;
    error: Error | null;
  }>;
  single(): Promise<{
    data: TResult | null;
    error: Error | null;
  }>;
}

interface UpdateEqClause {
  eq(column: string, value: string): UpdateExecClause;
}

interface UpdateExecClause {
  eq(column: string, value: string): Promise<{
    data: unknown;
    error: Error | null;
  }>;
}

interface UpdateQuery {
  update(value: Record<string, unknown>): UpdateEqClause;
}

interface SupabaseApiKeyClient {
  from(table: "api_keys"): InsertQuery<ApiKeyRecord> &
    SelectQuery<ApiKeyRecord> &
    UpdateQuery;
}

// ─── Repository ──────────────────────────────────────────────────────────

export interface ApiKeyRepository {
  create(params: {
    institutionId: string;
    label: string;
    prefix: string;
    keyHash: string;
    scopes: string;
  }): Promise<ApiKey>;
  findByHash(hash: string): Promise<ApiKey | null>;
  listActive(institutionId: string): Promise<ApiKey[]>;
  revoke(id: string, institutionId: string): Promise<void>;
}

export class SupabaseApiKeyRepository implements ApiKeyRepository {
  private readonly client: SupabaseApiKeyClient;

  public constructor(client: SupabaseApiKeyClient) {
    this.client = client;
  }

  public async create(params: {
    institutionId: string;
    label: string;
    prefix: string;
    keyHash: string;
    scopes: string;
  }): Promise<ApiKey> {
    const { data, error } = await this.client
      .from("api_keys")
      .insert({
        institution_id: params.institutionId,
        label: params.label,
        prefix: params.prefix,
        key_hash: params.keyHash,
        scopes: params.scopes,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return apiKeyFromRecord(data);
  }

  public async findByHash(hash: string): Promise<ApiKey | null> {
    const { data, error } = await this.client
      .from("api_keys")
      .select("*")
      .eq("key_hash", hash)
      .is("revoked_at", null)
      .single();

    if (error || !data) {
      return null;
    }

    return apiKeyFromRecord(data);
  }

  public async listActive(institutionId: string): Promise<ApiKey[]> {
    const { data, error } = await this.client
      .from("api_keys")
      .select("*")
      .eq("institution_id", institutionId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map(apiKeyFromRecord);
  }

  public async revoke(id: string, institutionId: string): Promise<void> {
    const { error } = await this.client
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("institution_id", institutionId);

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
  }
}

// ─── Service ─────────────────────────────────────────────────────────────

export interface ApiKeyManagementService {
  createKey(
    institutionId: string,
    label: string,
    scopes: string[],
  ): Promise<ApiKeyCreatedResponse>;
  listKeys(institutionId: string): Promise<ApiKey[]>;
  revokeKey(id: string, institutionId: string): Promise<void>;
  findKeyByToken(token: string): Promise<ApiKey | null>;
}

export class ApiKeyService implements ApiKeyManagementService {
  private readonly repository: ApiKeyRepository;

  public constructor(repository: ApiKeyRepository) {
    this.repository = repository;
  }

  public async createKey(
    institutionId: string,
    label: string,
    scopes: string[],
  ): Promise<ApiKeyCreatedResponse> {
    const { prefix, keyHash, fullKey } = generateApiKey();

    const apiKey = await this.repository.create({
      institutionId,
      label,
      prefix,
      keyHash,
      scopes: scopes.join(","),
    });

    return {
      ...apiKey,
      key: fullKey,
    };
  }

  public async listKeys(institutionId: string): Promise<ApiKey[]> {
    return this.repository.listActive(institutionId);
  }

  public async revokeKey(id: string, institutionId: string): Promise<void> {
    await this.repository.revoke(id, institutionId);
  }

  public async findKeyByToken(token: string): Promise<ApiKey | null> {
    const keyHash = hashApiKey(token);
    return this.repository.findByHash(keyHash);
  }
}
