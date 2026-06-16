import type {
  IntentLock,
  IntentLockRecord,
} from "../../models/intent-lock.js";
import type { SupabaseIntentLockRepository } from "../../services/intent-lock-repository.js";

/**
 * Captured call into the in-memory intent_locks client. Tests
 * assert on these to verify write/delete behavior without
 * poking at the internal `rows` array.
 */
export interface IntentLockCall {
  method:
    | "create"
    | "delete"
    | "setAmount"
    | "findOlderThan"
    | "findByInstitution";
  parameters?: unknown;
  result?: unknown;
}

type CreateInput = Parameters<SupabaseIntentLockRepository["create"]>[0];

/**
 * In-memory implementation of `IntentLockRepository` for
 * tests. Mirrors the Supabase client's interface so a test
 * can swap a real `SupabaseIntentLockRepository` for this
 * fake without changing any production code.
 *
 * The fake supports all four repository methods:
 * - `create` — appends a row, returns the new record
 * - `delete` — removes a row by `intent_handle`
 * - `findOlderThan` — returns rows whose `created_at` < cutoff
 * - `findByInstitution` — returns rows for an institution (and
 *   optionally a single agent)
 *
 * It also supports a `seed()` helper for setting up test
 * fixtures directly (e.g., a row from a "previous session"
 * to simulate a process restart).
 */
export class InMemoryIntentLockClient {
  public readonly rows: IntentLockRecord[] = [];
  public readonly calls: IntentLockCall[] = [];

  public constructor(initialRows: IntentLockRecord[] = []) {
    for (const row of initialRows) {
      this.rows.push({ ...row });
    }
  }

  /**
   * Append a row directly, bypassing the repository contract.
   * Used by tests to simulate a lock that was written in a
   * previous process (and is therefore an orphan from the
   * current orchestrator's perspective).
   */
  public seed(row: IntentLockRecord): void {
    this.rows.push({ ...row });
  }

  public async create(
    input: CreateInput,
  ): Promise<IntentLock> {
    if (
      this.rows.some((r) => r.intent_handle === input.intentHandle)
    ) {
      const error = new Error("duplicate key value violates unique constraint");
      this.calls.push({ method: "create", parameters: input, result: error });
      throw error;
    }

    const now = new Date();
    const record: IntentLockRecord = {
      intent_handle: input.intentHandle,
      institution_id: input.institutionId,
      asset_code: input.assetCode.toUpperCase(),
      amount: input.amount.toString(),
      correlation_ref: input.correlationRef ?? null,
      agent_did: input.agentDid ?? null,
      created_at: now.toISOString(),
    };

    this.rows.push(record);
    this.calls.push({ method: "create", parameters: input, result: record });

    return {
      intentHandle: record.intent_handle,
      institutionId: record.institution_id,
      assetCode: record.asset_code,
      amount: input.amount,
      correlationRef: record.correlation_ref,
      agentDid: record.agent_did,
      createdAt: record.created_at,
    };
  }

  public async delete(intentHandle: string): Promise<boolean> {
    const idx = this.rows.findIndex(
      (r) => r.intent_handle === intentHandle,
    );
    if (idx < 0) {
      this.calls.push({
        method: "delete",
        parameters: { intentHandle },
        result: false,
      });
      return false;
    }
    this.rows.splice(idx, 1);
    this.calls.push({
      method: "delete",
      parameters: { intentHandle },
      result: true,
    });
    return true;
  }

  public async setAmount(
    intentHandle: string,
    amount: number,
  ): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.intent_handle === intentHandle);
    if (!row) {
      this.calls.push({
        method: "setAmount",
        parameters: { intentHandle, amount },
        result: false,
      });
      return false;
    }

    row.amount = amount.toString();
    this.calls.push({
      method: "setAmount",
      parameters: { intentHandle, amount },
      result: true,
    });
    return true;
  }

  public async findOlderThan(
    timestamp: Date,
  ): Promise<readonly IntentLock[]> {
    const cutoff = timestamp.getTime();
    const matches = this.rows
      .filter((r) => new Date(r.created_at).getTime() < cutoff)
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
      .map((r) => ({
        intentHandle: r.intent_handle,
        institutionId: r.institution_id,
        assetCode: r.asset_code,
        amount: Number.parseFloat(r.amount),
        correlationRef: r.correlation_ref,
        agentDid: r.agent_did,
        createdAt: r.created_at,
      }));

    this.calls.push({
      method: "findOlderThan",
      parameters: { timestamp: timestamp.toISOString() },
      result: matches.length,
    });
    return matches;
  }

  public async findByInstitution(
    institutionId: string,
    agentDid?: string,
  ): Promise<readonly IntentLock[]> {
    const matches = this.rows
      .filter((r) => {
        if (r.institution_id !== institutionId) return false;
        if (agentDid && r.agent_did !== agentDid) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .map((r) => ({
        intentHandle: r.intent_handle,
        institutionId: r.institution_id,
        assetCode: r.asset_code,
        amount: Number.parseFloat(r.amount),
        correlationRef: r.correlation_ref,
        agentDid: r.agent_did,
        createdAt: r.created_at,
      }));

    this.calls.push({
      method: "findByInstitution",
      parameters: { institutionId, agentDid },
      result: matches.length,
    });
    return matches;
  }
}
