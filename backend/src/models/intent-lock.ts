/**
 * A reference to a balance reservation held against a single
 * intent. The matching orchestrator's pending-queue is
 * in-memory, so a process restart would otherwise orphan the
 * corresponding `portfolios.locked` amount. The
 * `intent_locks` table (see migration 011) persists a row per
 * lock so the orphan-lock janitor can find and release any
 * lock that has no live in-memory owner.
 *
 * The `intent_handle` is the TEE-assigned opaque handle —
 * the same key the orchestrator uses for its in-memory queue.
 * It is the natural primary key because it uniquely identifies
 * one intent and therefore one lock.
 */
export interface IntentLockRecord {
  intent_handle: string;
  institution_id: string;
  asset_code: string;
  amount: string; // numeric
  correlation_ref: string | null;
  agent_did: string | null;
  created_at: string;
}

export interface IntentLock {
  intentHandle: string;
  institutionId: string;
  assetCode: string;
  amount: number;
  correlationRef: string | null;
  agentDid: string | null;
  createdAt: string;
}

export function intentLockFromRecord(record: IntentLockRecord): IntentLock {
  return {
    intentHandle: record.intent_handle,
    institutionId: record.institution_id,
    assetCode: record.asset_code,
    amount: Number.parseFloat(record.amount),
    correlationRef: record.correlation_ref,
    agentDid: record.agent_did,
    createdAt: record.created_at,
  };
}

/**
 * Input to `IntentLockRepository.create`. `correlationRef` and
 * `agentDid` are optional; the table allows NULL on both.
 */
export interface CreateIntentLockInput {
  intentHandle: string;
  institutionId: string;
  assetCode: string;
  amount: number;
  correlationRef?: string | null;
  agentDid?: string | null;
}
