import { PublicError } from "../errors/public-error.js";

export interface PublishedMatchingContractRecord {
  tail: "matching";
  contractVersion: string;
  publishedAt: string;
  tenantDid: string;
  networkEnv: "testnet" | "production";
  wasmSize: number;
  handle?: string;
}

interface PublishedContractRow {
  tail: string;
  contract_version: string;
  network_env: string;
  tenant_did: string;
  wasm_size: number;
  handle: string | null;
  published_at: string;
}

interface PublishedContractSingleResult {
  data: PublishedContractRow | null;
  error: { message: string } | null;
}

interface PublishedContractMaybeSingleResult {
  data: PublishedContractRow | null;
  error: { message: string } | null;
}

interface PublishedContractUpsertResult {
  error: { message: string } | null;
}

interface PublishedContractSelectChain {
  eq(column: string, value: string): PublishedContractSelectChain;
  order(
    column: string,
    options: { ascending: boolean },
  ): PublishedContractSelectChain;
  limit(n: number): PublishedContractSelectChain;
  maybeSingle(): Promise<PublishedContractMaybeSingleResult>;
}

interface PublishedContractUpsertChain {
  eq(column: string, value: string): PublishedContractUpsertChain;
  select(columns: string): Promise<PublishedContractSingleResult>;
}

interface PublishedContractUpdateChain {
  eq(column: string, value: string): PublishedContractUpdateChain;
}

interface PublishedContractTableQuery {
  select(columns: string): PublishedContractSelectChain;
  upsert(
    row: Record<string, unknown>,
    options: { onConflict: string },
  ): PublishedContractUpsertChain;
  update(row: Record<string, unknown>): PublishedContractUpdateChain;
}

export interface PublishedContractRepository {
  loadLatestMatching(args: {
    tenantDid: string;
    networkEnv: "testnet" | "production";
  }): Promise<PublishedMatchingContractRecord | null>;

  upsertMatching(record: PublishedMatchingContractRecord): Promise<void>;
}

export interface PublishedContractSupabaseClient {
  from(table: "published_contracts"): PublishedContractTableQuery;
}

function toRecord(row: PublishedContractRow): PublishedMatchingContractRecord {
  const networkEnv: PublishedMatchingContractRecord["networkEnv"] =
    row.network_env === "production" ? "production" : "testnet";
  return {
    tail: "matching",
    contractVersion: row.contract_version,
    publishedAt: row.published_at,
    tenantDid: row.tenant_did,
    networkEnv,
    wasmSize: row.wasm_size,
    ...(typeof row.handle === "string" && row.handle.length > 0
      ? { handle: row.handle }
      : {}),
  };
}

export class SupabasePublishedContractRepository
  implements PublishedContractRepository
{
  private readonly client: PublishedContractSupabaseClient;

  public constructor(client: PublishedContractSupabaseClient) {
    this.client = client;
  }

  public async loadLatestMatching(args: {
    tenantDid: string;
    networkEnv: "testnet" | "production";
  }): Promise<PublishedMatchingContractRecord | null> {
    const { data, error } = await this.client
      .from("published_contracts")
      .select(
        "tail, contract_version, network_env, tenant_did, wasm_size, handle, published_at",
      )
      .eq("tail", "matching")
      .eq("network_env", args.networkEnv)
      .eq("tenant_did", args.tenantDid)
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new PublicError(
        "service_unavailable",
        503,
        `Failed to load published contracts: ${error.message}`,
      );
    }

    if (!data) {
      return null;
    }

    return toRecord(data);
  }

  public async upsertMatching(
    record: PublishedMatchingContractRecord,
  ): Promise<void> {
    const dbRow: Record<string, unknown> = {
      tail: record.tail,
      contract_version: record.contractVersion,
      network_env: record.networkEnv,
      tenant_did: record.tenantDid,
      wasm_size: record.wasmSize,
      published_at: record.publishedAt,
      ...(record.handle ? { handle: record.handle } : { handle: null }),
    };

    const { data, error }: PublishedContractSingleResult = await this.client
      .from("published_contracts")
      .upsert(dbRow, {
        onConflict: "tail,contract_version,network_env,tenant_did",
      })
      .eq("tail", record.tail)
      .eq("contract_version", record.contractVersion)
      .eq("network_env", record.networkEnv)
      .eq("tenant_did", record.tenantDid)
      .select(
        "tail, contract_version, network_env, tenant_did, wasm_size, handle, published_at",
      );

    if (error) {
      throw new PublicError(
        "service_unavailable",
        503,
        `Failed to persist published contract: ${error.message}`,
      );
    }

    if (!data) {
      throw new PublicError(
        "service_unavailable",
        503,
        "Published-contract upsert returned no row.",
      );
    }
  }
}

export class EmptyPublishedContractRepository
  implements PublishedContractRepository
{
  public async loadLatestMatching(): Promise<PublishedMatchingContractRecord | null> {
    return null;
  }

  public async upsertMatching(): Promise<void> {
    // No-op: empty repository never persists anything.
  }
}

void ((): PublishedContractUpsertResult => ({ error: null }))();
