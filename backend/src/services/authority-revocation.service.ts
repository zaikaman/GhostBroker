import { PublicError } from "../errors/public-error.js";
import { logger } from "../logging/logger.js";
import type { SdkDelegationEnvelope } from "../enclave/auth/sdk-delegation-signer.js";
import {
  revokeSdkDelegation,
  type SdkRevokeOptions,
} from "../enclave/auth/sdk-delegation-signer.js";
import type { T3nClient } from "@terminal3/t3n-sdk";

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

export interface AuthorityRevocationInput {
  institutionId: string;
  agentDid: string;
  agentId: string;
  /**
   * The SDK delegation envelope persisted on the agent's
   * metadata at configure time. When present and a T3nClient
   * is available, the revocation is performed on-chain via
   * `revokeDelegation` so the TEE can verify it. When absent,
   * only the Supabase-side revocation record is written.
   */
  sdkEnvelope?: SdkDelegationEnvelope;
  /**
   * Omit to revoke the whole credential. Pass a subset of
   * WIT function names to revoke only those functions
   * (per-function revocation, e.g. revoke just
   * "settlement-execute" while keeping "seal-intent" live).
   */
  revokedFunctions?: string[];
}

export interface AuthorityRevocationRepository {
  listRevokedAuthorityRefs(
    institutionId: string,
    agentDid: string,
  ): Promise<ReadonlySet<string>>;
  /**
   * Revoke a delegation credential. When the agent has an
   * SDK delegation envelope and a T3nClient is available,
   * the revocation is performed on-chain via the SDK's
   * `revokeDelegation` (the `tee:delegation/contracts::revoke`
   * entrypoint) in addition to the Supabase-side record.
   * Falls back to Supabase-only revocation when the SDK
   * envelope or T3nClient is not available.
   */
  revokeAuthority(input: AuthorityRevocationInput): Promise<void>;
}

export interface SupabaseAuthorityRevocationClient {
  from(table: "agent_authority_revocations"): AuthorityRevocationTableQuery;
}

/**
 * Supabase-only revocation repository. Writes revocation
 * records to the `agent_authority_revocations` table and
 * reads them back as a `Set<string>` for the verifier's
 * revocation check. No on-chain revocation.
 */
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

  public async revokeAuthority(_input: AuthorityRevocationInput): Promise<void> {
    // Supabase-only repository does not perform on-chain
    // revocation. The agent record's `status` column is
    // set to "revoked" by the AgentService, and the
    // verifier's revocation check reads from the
    // `agent_authority_revocations` table.
    //
    // On-chain revocation is handled by the
    // SdkAuthorityRevocationRepository wrapper.
  }
}

/**
 * SDK-native revocation repository that wraps a Supabase
 * repository and adds on-chain revocation via the SDK's
 * `revokeDelegation`. When the agent has an SDK delegation
 * envelope (persisted at configure time by the SDK-native
 * minting path) and a T3nClient is available, the revocation
 * is performed on-chain so the TEE can verify it.
 *
 * This enables per-function revocation: pass
 * `revokedFunctions: ["settlement-execute"]` to revoke just
 * the settlement function while keeping intent submission
 * live. The SDK's `revokeDelegation` handles merge semantics
 * server-side (per-function revocations accumulate as a
 * sorted + deduped union across calls).
 */
export class SdkAuthorityRevocationRepository
  implements AuthorityRevocationRepository
{
  private readonly delegate: AuthorityRevocationRepository;
  private readonly t3nClient: T3nClient | undefined;

  public constructor(
    delegate: AuthorityRevocationRepository,
    t3nClient?: T3nClient,
  ) {
    this.delegate = delegate;
    this.t3nClient = t3nClient;
  }

  public async listRevokedAuthorityRefs(
    institutionId: string,
    agentDid: string,
  ): Promise<ReadonlySet<string>> {
    return this.delegate.listRevokedAuthorityRefs(institutionId, agentDid);
  }

  public async revokeAuthority(input: AuthorityRevocationInput): Promise<void> {
    // Always delegate the Supabase-side record write.
    await this.delegate.revokeAuthority(input);

    // If the agent has an SDK delegation envelope and a
    // T3nClient is available, also revoke on-chain.
    if (input.sdkEnvelope && this.t3nClient) {
      try {
        const opts: SdkRevokeOptions = {
          envelope: {
            credentialJcsB64u: input.sdkEnvelope.credentialJcsB64u,
            functions: input.sdkEnvelope.functions,
          },
          client: this.t3nClient,
          ...(input.revokedFunctions
            ? { revokedFunctions: input.revokedFunctions }
            : {}),
        };
        const result = await revokeSdkDelegation(opts);
        logger.info(
          {
            event: "authority_revocation.on_chain_succeeded",
            agentId: input.agentId,
            vcId: result.vcId,
            revokedFunctions: result.revokedFunctions,
          },
          "On-chain delegation revocation succeeded.",
        );
      } catch (error) {
        // On-chain revocation failed (e.g. T3N network
        // unavailable, delegation contract not provisioned,
        // or the credential's user_did does not match the
        // T3nClient's authenticated DID). The Supabase-side
        // revocation still took effect, so the verifier will
        // reject the credential on the next privileged call.
        // Log the error but do not throw - the agent is
        // already revoked in the database.
        logger.warn(
          {
            event: "authority_revocation.on_chain_failed",
            agentId: input.agentId,
            err: error instanceof Error ? error.message : String(error),
          },
          "On-chain delegation revocation failed; Supabase-side revocation still active.",
        );
      }
    }
  }
}

export class EmptyAuthorityRevocationRepository
  implements AuthorityRevocationRepository
{
  public async listRevokedAuthorityRefs(): Promise<ReadonlySet<string>> {
    return new Set();
  }

  public async revokeAuthority(): Promise<void> {
    // No-op: no revocation store configured.
  }
}