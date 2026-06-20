import { PublicError } from "../errors/public-error.js";

export interface TenantIdentityRow {
  tenantDid: string;
  signingPrivateKey: string;
  signingPublicKey: string;
  signingAddress: string;
  issuerDid: string;
  createdAt: string;
  updatedAt: string;
}

interface TenantIdentityRawRow {
  tenant_did: string;
  signing_private_key: string;
  signing_public_key: string;
  signing_address: string;
  issuer_did: string;
  created_at: string;
  updated_at: string;
}

interface TenantIdentitySingleResult {
  data: TenantIdentityRawRow | null;
  error: { message: string } | null;
}

interface TenantIdentityMaybeSingleResult {
  data: TenantIdentityRawRow | null;
  error: { message: string } | null;
}

interface TenantIdentityUpsertResult {
  error: { message: string } | null;
}

interface TenantIdentitySelectChain {
  eq(column: string, value: string): TenantIdentitySelectChain;
  maybeSingle(): Promise<TenantIdentityMaybeSingleResult>;
}

interface TenantIdentityUpdateChain {
  eq(column: string, value: string): {
    select(columns: string): Promise<TenantIdentitySingleResult>;
  };
}

interface TenantIdentityTableQuery {
  select(columns: string): TenantIdentitySelectChain;
  upsert(
    row: Record<string, unknown>,
    options: { onConflict: string },
  ): {
    select(columns: string): Promise<TenantIdentitySingleResult>;
  };
  update(row: Record<string, unknown>): TenantIdentityUpdateChain;
}

export interface TenantIdentityRepository {
  load(tenantDid: string): Promise<TenantIdentityRow | null>;

  upsert(row: Omit<TenantIdentityRow, "createdAt" | "updatedAt">): Promise<TenantIdentityRow>;
}

export interface TenantIdentitySupabaseClient {
  from(table: "tenant_identities"): TenantIdentityTableQuery;
}

function toRow(raw: TenantIdentityRawRow): TenantIdentityRow {
  return {
    tenantDid: raw.tenant_did,
    signingPrivateKey: raw.signing_private_key,
    signingPublicKey: raw.signing_public_key,
    signingAddress: raw.signing_address,
    issuerDid: raw.issuer_did,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class SupabaseTenantIdentityRepository implements TenantIdentityRepository {
  private readonly client: TenantIdentitySupabaseClient;

  public constructor(client: TenantIdentitySupabaseClient) {
    this.client = client;
  }

  public async load(tenantDid: string): Promise<TenantIdentityRow | null> {
    const { data, error } = await this.client
      .from("tenant_identities")
      .select(
        "tenant_did, signing_private_key, signing_public_key, signing_address, issuer_did, created_at, updated_at",
      )
      .eq("tenant_did", tenantDid)
      .maybeSingle();

    if (error) {
      throw new PublicError(
        "service_unavailable",
        503,
        `Failed to load tenant identity: ${error.message}`,
      );
    }

    if (!data) {
      return null;
    }

    return toRow(data);
  }

  public async upsert(
    row: Omit<TenantIdentityRow, "createdAt" | "updatedAt">,
  ): Promise<TenantIdentityRow> {
    const dbRow: Record<string, unknown> = {
      tenant_did: row.tenantDid,
      signing_private_key: row.signingPrivateKey,
      signing_public_key: row.signingPublicKey,
      signing_address: row.signingAddress,
      issuer_did: row.issuerDid,
    };

    const { data, error }: TenantIdentitySingleResult = await this.client
      .from("tenant_identities")
      .upsert(dbRow, { onConflict: "tenant_did" })
      .select(
        "tenant_did, signing_private_key, signing_public_key, signing_address, issuer_did, created_at, updated_at",
      );

    if (error) {
      throw new PublicError(
        "service_unavailable",
        503,
        `Failed to upsert tenant identity: ${error.message}`,
      );
    }

    if (!data) {
      throw new PublicError(
        "service_unavailable",
        503,
        "Tenant identity upsert returned no row.",
      );
    }

    return toRow(data);
  }
}

export class EmptyTenantIdentityRepository implements TenantIdentityRepository {
  public async load(): Promise<TenantIdentityRow | null> {
    return null;
  }

  public async upsert(
    row: Omit<TenantIdentityRow, "createdAt" | "updatedAt">,
  ): Promise<TenantIdentityRow> {
    return {
      ...row,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

void ((): TenantIdentityUpsertResult => ({ error: null }))();
