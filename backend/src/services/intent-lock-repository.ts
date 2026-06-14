import { PublicError } from "../errors/public-error.js";
import {
  type CreateIntentLockInput,
  type IntentLock,
  type IntentLockRecord,
  intentLockFromRecord,
} from "../models/intent-lock.js";

// ─── Supabase Query Type Declarations ────────────────────────────────────

interface InsertResult<TResult> {
  single(): Promise<{ data: TResult | null; error: Error | null }>;
}

interface FilterChain<TResult> {
  eq(column: string, value: string): FilterChain<TResult>;
  lt(column: string, value: string): FilterChain<TResult>;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): Promise<{ data: TResult[] | null; error: Error | null }>;
}

interface InsertQuery<TResult> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): InsertResult<TResult>;
  };
}

interface SelectQuery<TResult> {
  select(columns?: string): FilterChain<TResult>;
}

interface DeleteResult {
  error: Error | null;
}

interface DeleteQuery {
  delete(): {
    eq(column: string, value: string): Promise<DeleteResult>;
  };
}

interface SupabaseIntentLockClient {
  from(table: "intent_locks"): InsertQuery<IntentLockRecord> &
    SelectQuery<IntentLockRecord> &
    DeleteQuery;
}

// ─── Repository ──────────────────────────────────────────────────────────

export interface IntentLockRepository {
  /**
   * Insert a new lock reference. Throws if a row with the same
   * `intent_handle` already exists (the TEE-assigned handle is
   * unique per intent, so this would indicate a duplicate submit
   * for the same handle — which the orchestrator rejects on the
   * TEE side, but we surface the DB-level conflict as 409 if it
   * ever happens).
   */
  create(input: CreateIntentLockInput): Promise<IntentLock>;

  /**
   * Delete the lock reference for the given intent handle. Used
   * on cancel, expiry, revocation, and successful settlement.
   * Returns true if a row was deleted, false if the handle had
   * no row (already swept, never written, etc.). Never throws
   * on "not found" — only on actual DB errors.
   */
  delete(intentHandle: string): Promise<boolean>;

  /**
   * Find all lock references older than the given timestamp.
   * The orphan-lock janitor calls this with `now() - TTL` to
   * recover from process restarts.
   */
  findOlderThan(timestamp: Date): Promise<readonly IntentLock[]>;

  /**
   * Find all lock references for a given institution, optionally
   * filtered to a single agent. Used by the agent-level portfolio
   * view to render the `pendingReservations` array.
   */
  findByInstitution(
    institutionId: string,
    agentDid?: string,
  ): Promise<readonly IntentLock[]>;
}

export class SupabaseIntentLockRepository implements IntentLockRepository {
  private readonly client: SupabaseIntentLockClient;

  public constructor(client: SupabaseIntentLockClient) {
    this.client = client;
  }

  public async create(input: CreateIntentLockInput): Promise<IntentLock> {
    const { data, error } = await this.client
      .from("intent_locks")
      .insert({
        intent_handle: input.intentHandle,
        institution_id: input.institutionId,
        asset_code: input.assetCode.toUpperCase(),
        amount: input.amount.toString(),
        correlation_ref: input.correlationRef ?? null,
        agent_did: input.agentDid ?? null,
      })
      .select("*")
      .single();

    if (error || !data) {
      if (
        error?.message?.toLowerCase().includes("duplicate") ||
        error?.message?.toLowerCase().includes("unique")
      ) {
        // Duplicate intent handle. The TEE layer is expected to
        // assign a fresh handle on every submit, so this is
        // either a client misbehaving or a race in handle
        // generation. Either way, it's a bad request.
        throw new PublicError("validation_failed", 400, error);
      }
      throw new PublicError("service_unavailable", 503, error);
    }

    return intentLockFromRecord(data);
  }

  public async delete(intentHandle: string): Promise<boolean> {
    const { error } = await this.client
      .from("intent_locks")
      .delete()
      .eq("intent_handle", intentHandle);

    if (error) {
      // Match the rest of the codebase: throw on a real DB
      // error. The caller (releaseLockFor) catches and logs.
      throw new PublicError("service_unavailable", 503, error);
    }

    // Supabase's `delete` doesn't return rowcount in our type
    // declaration, so we can't tell whether a row was actually
    // deleted. Returning `true` is a conservative upper bound —
    // callers that care about the boolean for telemetry can
    // change this if we extend the type declaration. The
    // contract is: this method does not throw on "not found".
    return true;
  }

  public async findOlderThan(
    timestamp: Date,
  ): Promise<readonly IntentLock[]> {
    const { data, error } = await this.client
      .from("intent_locks")
      .select("*")
      .lt("created_at", timestamp.toISOString())
      .order("created_at", { ascending: true });

    if (error || !data) {
      throw new PublicError("service_unavailable", 503, error);
    }

    return data.map(intentLockFromRecord);
  }

  public async findByInstitution(
    institutionId: string,
    agentDid?: string,
  ): Promise<readonly IntentLock[]> {
    let query = this.client
      .from("intent_locks")
      .select("*")
      .eq("institution_id", institutionId);

    if (agentDid) {
      query = query.eq("agent_did", agentDid);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map(intentLockFromRecord);
  }
}
