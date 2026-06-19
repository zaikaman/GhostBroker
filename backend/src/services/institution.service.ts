import {
  type TenantDidRegistry,
  rotateEnvelopeKey,
  createEnvelopeKeyMetadata,
} from "../enclave/index.js";
import { PublicError } from "../errors/public-error.js";
import {
  institutionFromRecord,
  type CreateInstitutionRequest,
  type Institution,
  type InstitutionRecord,
} from "../models/institution.js";
import type { DepositWalletService } from "./deposit-wallet.service.js";

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
      single(): Promise<{ data: TResult | null; error: Error | null }>;
    };
  };
}

interface UpdateQuery<TResult> {
  update(value: Record<string, unknown>): {
    eq(column: string, value: string): {
      select(columns?: string): {
        single(): Promise<{ data: TResult | null; error: Error | null }>;
      };
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
  updateMetadata?(id: string, metadata: Readonly<Record<string, unknown>>): Promise<Institution>;
  /**
   * Update the institution's `settlement_profile_ref` column
   * in-place. Used by the WS3 PATCH endpoint when the operator
   * switches the institution between rail profiles
   * (`settlement-profile:*` legacy → `chain:sepolia:erc20`,
   * which is the only supported production profile).
   */
  updateProfile?(id: string, settlementProfileRef: string): Promise<Institution>;
}

export interface InstitutionManagementService {
  createInstitution(request: CreateInstitutionRequest): Promise<Institution>;
  getInstitution?(id: string): Promise<Institution>;
  rotateKeys?(id: string): Promise<Institution>;
  /**
   * WS3: update an institution's settlement profile and/or
   * chain-rail metadata. The new profile must satisfy the
   * same chain-rail validation as `createInstitution`. The
   * institution id is unchanged; trades already settled
   * under the old profile are not affected (their
   * `rail_trade_ref` carries the original rail).
   */
  updateInstitution?(
    id: string,
    request: { settlementProfileRef?: string; metadata?: Readonly<Record<string, unknown>> },
  ): Promise<Institution>;
}

export interface SupabaseInstitutionClient {
  from(table: "institutions"): InsertQuery<InstitutionRecord> &
    SelectQuery<InstitutionRecord> &
    UpdateQuery<InstitutionRecord>;
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

  public async updateMetadata(
    id: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<Institution> {
    const { data, error } = await this.client
      .from("institutions")
      .update({ metadata })
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return institutionFromRecord(data);
  }

  public async updateProfile(
    id: string,
    settlementProfileRef: string,
  ): Promise<Institution> {
    const { data, error } = await this.client
      .from("institutions")
      .update({ settlement_profile_ref: settlementProfileRef })
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return institutionFromRecord(data);
  }
}

export class InstitutionService implements InstitutionManagementService {
  private readonly repository: InstitutionRepository;
  private readonly didRegistry: TenantDidRegistry;
  private readonly depositWalletService: DepositWalletService | undefined;
  private readonly defaultChainTokenAddresses:
    | Readonly<Record<string, string>>
    | undefined;

  public constructor(
    repository: InstitutionRepository,
    didRegistry: TenantDidRegistry,
    depositWalletService?: DepositWalletService,
    defaultChainTokenAddresses?: Readonly<Record<string, string>>,
  ) {
    this.repository = repository;
    this.didRegistry = didRegistry;
    this.depositWalletService = depositWalletService;
    this.defaultChainTokenAddresses = defaultChainTokenAddresses;
  }

  public async createInstitution(
    request: CreateInstitutionRequest,
  ): Promise<Institution> {
    const tenant = await this.didRegistry.resolveOrRegisterTenantDid({
      legalName: request.legalName,
      displayName: request.displayName,
      settlementProfileRef: request.settlementProfileRef,
    });

    const metadata = this.enrichChainRailMetadata(
      request.settlementProfileRef,
      request.metadata ?? {},
      tenant.tenantDid,
    );

    return this.repository.createInstitution({
      legalName: request.legalName,
      displayName: request.displayName,
      settlementProfileRef: request.settlementProfileRef,
      t3TenantDid: tenant.tenantDid,
      metadata,
    });
  }

  public async getInstitution(id: string): Promise<Institution> {
    const institution = await this.repository.findById(id);
    if (!institution) {
      throw new PublicError("not_found", 404, "Institution not found");
    }
    return institution;
  }

  /**
   * WS3: update the institution's settlement profile and/or
   * chain-rail metadata. The current institution must
   * exist; the new profile must satisfy the same
   * chain-rail validation as `createInstitution`. The
   * repository's `updateMetadata` is a full-merge
   * operation; we read the current row, merge in the new
   * fields, and write the merged record.
   *
   * Trades already settled under the old profile are not
   * affected — their `completed_trades.rail_trade_ref`
   * carries the original rail. The dispatcher picks the
   * rail per-trade from the current
   * `institutions.settlement_profile_ref`, so a profile
   * change applies to **future** trades only.
   */
  public async updateInstitution(
    id: string,
    request: { settlementProfileRef?: string; metadata?: Readonly<Record<string, unknown>> },
  ): Promise<Institution> {
    const current = await this.repository.findById(id);
    if (!current) {
      throw new PublicError("not_found", 404, "Institution not found");
    }

    const nextProfile = request.settlementProfileRef ?? current.settlementProfileRef;
    const mergedMetadata: Record<string, unknown> = {
      ...((current.metadata as Record<string, unknown> | undefined) ?? {}),
      ...((request.metadata as Record<string, unknown> | undefined) ?? {}),
    };
    const nextMetadata = this.enrichChainRailMetadata(
      nextProfile,
      mergedMetadata,
      current.t3TenantDid,
    );

    // Persist the metadata update first via the repository's
    // `updateMetadata`, then the profile via a direct
    // `settlement_profile_ref` write. Both writers are part
    // of the production `SupabaseInstitutionRepository`; the
    // service refuses to silently no-op a profile change
    // when the repository is missing the writer, so a
    // misconfigured test composition surfaces the gap
    // explicitly.
    if (request.metadata !== undefined) {
      if (!this.repository.updateMetadata) {
        throw new PublicError(
          "service_unavailable",
          503,
          "updateInstitution: repository does not support updateMetadata",
        );
      }
      await this.repository.updateMetadata(id, nextMetadata);
    }
    if (request.settlementProfileRef !== undefined) {
      if (!this.repository.updateProfile) {
        throw new PublicError(
          "service_unavailable",
          503,
          "updateInstitution: repository does not support updateProfile; the institution service must be wired with SupabaseInstitutionRepository for settlement-profile changes.",
        );
      }
      return this.repository.updateProfile(id, nextProfile);
    }

    if (request.metadata !== undefined) {
      const refreshed = await this.repository.findById(id);
      return refreshed ?? current;
    }

    return {
      ...current,
      settlementProfileRef: nextProfile,
      metadata: nextMetadata,
    };
  }

  public async rotateKeys(id: string): Promise<Institution> {
    const institution = await this.repository.findById(id);
    if (!institution) {
      throw new PublicError("not_found", 404, "Institution not found");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentMetadata = (institution.metadata || {}) as Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentKeys = (currentMetadata.envelopeKeys || {}) as Record<string, any>;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nextKeys: Record<string, any> = {};

    // 1. Rotate/generate hidden_intent key
    const prevIntent = currentKeys.hidden_intent?.keyVersion;
    let newIntentKey;
    if (prevIntent) {
      newIntentKey = rotateEnvelopeKey({
        institutionDid: institution.t3TenantDid,
        purpose: "hidden_intent",
        previousKeyVersion: prevIntent,
      });
    } else {
      newIntentKey = {
        current: createEnvelopeKeyMetadata({
          institutionDid: institution.t3TenantDid,
          purpose: "hidden_intent",
        }),
        rotatedAt: new Date().toISOString(),
      };
    }
    nextKeys.hidden_intent = {
      keyVersion: newIntentKey.current.keyVersion,
      publicKeyRef: newIntentKey.current.publicKeyRef,
      createdAt: newIntentKey.rotatedAt,
    };

    // 2. Rotate/generate receipt key
    const prevReceipt = currentKeys.receipt?.keyVersion;
    let newReceiptKey;
    if (prevReceipt) {
      newReceiptKey = rotateEnvelopeKey({
        institutionDid: institution.t3TenantDid,
        purpose: "receipt",
        previousKeyVersion: prevReceipt,
      });
    } else {
      newReceiptKey = {
        current: createEnvelopeKeyMetadata({
          institutionDid: institution.t3TenantDid,
          purpose: "receipt",
        }),
        rotatedAt: new Date().toISOString(),
      };
    }
    nextKeys.receipt = {
      keyVersion: newReceiptKey.current.keyVersion,
      publicKeyRef: newReceiptKey.current.publicKeyRef,
      createdAt: newReceiptKey.rotatedAt,
    };

    const nextMetadata = {
      ...currentMetadata,
      envelopeKeys: nextKeys,
    };

    if (!this.repository.updateMetadata) {
      throw new PublicError(
        "service_unavailable",
        503,
        "rotateKeys: repository does not support updateMetadata",
      );
    }
    return this.repository.updateMetadata(id, nextMetadata);
  }

  private enrichChainRailMetadata(
    settlementProfileRef: string,
    metadata: Readonly<Record<string, unknown>>,
    institutionSeed: string,
  ): Readonly<Record<string, unknown>> {
    if (settlementProfileRef !== "chain:sepolia:erc20") {
      return metadata;
    }
    if (!this.depositWalletService) {
      throw new PublicError(
        "service_unavailable",
        503,
        "Chain-rail institution setup requires a configured deposit-wallet service.",
      );
    }

    const existingTokenAddresses =
      metadata["tokenAddresses"] && typeof metadata["tokenAddresses"] === "object"
        ? (metadata["tokenAddresses"] as Record<string, unknown>)
        : {};
    const normalizedTokenAddresses: Record<string, string> = {};
    for (const [key, value] of Object.entries(existingTokenAddresses)) {
      if (typeof value === "string" && value.length > 0) {
        normalizedTokenAddresses[key] = value;
      }
    }
    for (const [key, value] of Object.entries(this.defaultChainTokenAddresses ?? {})) {
      if (!normalizedTokenAddresses[key]) {
        normalizedTokenAddresses[key] = value;
      }
    }

    return {
      ...metadata,
      depositAddress: this.depositWalletService.deriveDepositAddress(institutionSeed),
      tokenAddresses: normalizedTokenAddresses,
    };
  }
}
