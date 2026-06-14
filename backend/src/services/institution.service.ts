import type { TenantDidRegistry } from "@ghostbroker/t3-enclave";
import { PublicError } from "../errors/public-error.js";
import {
  institutionFromRecord,
  type CreateInstitutionRequest,
  type Institution,
  type InstitutionRecord,
} from "../models/institution.js";

interface InsertQuery<TResult> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): {
      single(): Promise<{ data: TResult | null; error: Error | null }>;
    };
  };
}

interface SelectQuery<TResult> {
  select(columns?: string): {
    eq(column: string, value: string): {
      maybeSingle(): Promise<{ data: TResult | null; error: Error | null }>;
    };
  };
}

export interface InstitutionRepository {
  createInstitution(value: {
    legalName: string;
    displayName: string;
    settlementProfileRef: string;
    t3TenantDid: string;
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<Institution>;
  findByTenantDid(did: string): Promise<Institution | null>;
  findById(id: string): Promise<Institution | null>;
}

export interface InstitutionManagementService {
  createInstitution(request: CreateInstitutionRequest): Promise<Institution>;
}

export interface SupabaseInstitutionClient {
  from(table: "institutions"): InsertQuery<InstitutionRecord> &
    SelectQuery<InstitutionRecord>;
}

export class SupabaseInstitutionRepository implements InstitutionRepository {
  private readonly client: SupabaseInstitutionClient;

  public constructor(client: SupabaseInstitutionClient) {
    this.client = client;
  }

  public async createInstitution(value: {
    legalName: string;
    displayName: string;
    settlementProfileRef: string;
    t3TenantDid: string;
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<Institution> {
    const { data, error } = await this.client
      .from("institutions")
      .insert({
        legal_name: value.legalName,
        display_name: value.displayName,
        status: "active",
        t3_tenant_did: value.t3TenantDid,
        settlement_profile_ref: value.settlementProfileRef,
        metadata: value.metadata,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return institutionFromRecord(data);
  }

  public async findByTenantDid(did: string): Promise<Institution | null> {
    const { data, error } = await this.client
      .from("institutions")
      .select("*")
      .eq("t3_tenant_did", did)
      .maybeSingle();

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return data ? institutionFromRecord(data) : null;
  }

  public async findById(id: string): Promise<Institution | null> {
    const { data, error } = await this.client
      .from("institutions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return data ? institutionFromRecord(data) : null;
  }
}

export class InstitutionService implements InstitutionManagementService {
  private readonly repository: InstitutionRepository;
  private readonly didRegistry: TenantDidRegistry;

  public constructor(
    repository: InstitutionRepository,
    didRegistry: TenantDidRegistry,
  ) {
    this.repository = repository;
    this.didRegistry = didRegistry;
  }

  public async createInstitution(
    request: CreateInstitutionRequest,
  ): Promise<Institution> {
    const tenant = await this.didRegistry.resolveOrRegisterTenantDid({
      legalName: request.legalName,
      displayName: request.displayName,
      settlementProfileRef: request.settlementProfileRef,
    });

    return this.repository.createInstitution({
      legalName: request.legalName,
      displayName: request.displayName,
      settlementProfileRef: request.settlementProfileRef,
      t3TenantDid: tenant.tenantDid,
      metadata: request.metadata ?? {},
    });
  }
}
