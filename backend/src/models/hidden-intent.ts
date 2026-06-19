import { z } from "zod";
import { agentDidSchema } from "./agent.js";

export const encryptedIntentEnvelopeSchema = z
  .string()
  .trim()
  .min(32)
  .max(32768)
  .regex(/^[A-Za-z0-9._~:/+=-]+$/u);

/**
 * The intent submit wire format. Carries only what the orchestrator
 * is allowed to see outside the TEE: the institution + agent identity,
 * the TEE-sealed envelope (the agent sealed `assetCode`, `side`,
 * `quantity`, and `price` into this envelope via the T3 runner), the
 * authority reference for the GhostBroker delegation VC, and a
 * correlation id. There is no plaintext `settlementMetadata` field;
 * the orchestrator never sees active order parameters. The TEE
 * returns a TEE-attested lock descriptor on the seal path, which is
 * the only authority the orchestrator consults for the balance lock.
 */
export const hiddenIntentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  encryptedIntentEnvelope: encryptedIntentEnvelopeSchema,
  authorityRef: z.string().trim().min(8).max(512),
});

export type HiddenIntentRequest = z.infer<typeof hiddenIntentRequestSchema>;

export type HiddenIntentState = "intent_sealed";

export interface HiddenIntentAccepted {
  intentHandle: string;
  state: HiddenIntentState;
}

/**
 * Body for `POST /api/agents/intents/cancel`.
 *
 * Cancels a previously submitted intent that is still pending in the
 * matching orchestrator. The caller is the same agent that submitted
 * the intent (authenticated via API key). Institution-scope is
 * enforced and the agent's admission must still be active.
 *
 * Operators who need to invalidate an agent's pending intents should
 * use `POST /api/agents/:id/revoke`, which cascades through
 * `MatchingOrchestrator.removeIntentsByAgent`.
 */
export const cancelIntentRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: agentDidSchema,
  intentHandle: z.string().trim().min(1).max(256),
  authorityRef: z.string().trim().min(8).max(512),
});

export type CancelIntentRequest = z.infer<typeof cancelIntentRequestSchema>;

export interface IntentCancelled {
  intentHandle: string;
  state: "intent_cancelled";
}

/**
 * The orchestrator's in-memory view of a sealed intent. Stores only
 * opaque identifiers and the TEE-sealed envelope; the orchestrator
 * never holds plaintext asset / side / quantity / price. Balance
 * math consumes the TEE-attested `opaqueLockDescriptor` returned by
 * the seal call; matching consumes the envelope handles and forwards
 * the envelopes to the T3 enclave. The TEE is the single authority
 * for active order values.
 */
export interface PendingIntent {
  correlationRef: string;
  institutionId: string;
  agentDid: string;
  intentHandle: string;
  executionRef: string;
  encryptedEnvelope: string;
  authorityRef: string;
  /**
   * The Ghostbroker delegation W3C VC the agent was admitted with, snapshotted
   * at submit time. The settlement command builder re-verifies
   * both the buyer and seller VCs from this field on every match.
   * The VC is also re-fetchable from the agent record by
   * `institutionId` + `agentDid`, but storing it on the intent
   * lets the orchestrator settle without an extra DB round-trip.
   */
  delegationCredential: unknown;
  /**
   * TEE-attested lock descriptor produced by the seal call. The T3
   * enclave decrypts the envelope, derives the per-intent
   * reservation (`assetCode` + `amount`), and returns this as the
   * authoritative balance-lock claim. The orchestrator forwards it
   * to the portfolio service for the SQL reservation; the
   * orchestrator itself never holds plaintext trading parameters.
   */
  opaqueLockDescriptor: T3LockDescriptor;
  /** When this intent was added to the pending queue */
  sealedAt: string;
  /** Agent authority limits — checked at matching time */
  instrumentScope?: string[];
  directionScope?: string[];
  maxNotional?: string;
}

/**
 * TEE-attested balance-lock claim. The asset code, amount, and
 * side here are NOT plaintext trading parameters -- they are the
 * derived reservation values the T3 enclave computed after
 * decrypting the envelope. The TEE signs this descriptor; the
 * portfolio service SQL update and the orchestrator's local
 * match filter are the only consumers. Anything outside this
 * reservation descriptor (the raw `quantity` and `bidPrice`
 * sealed into the envelope) is held only inside the TEE.
 *
 * The descriptor carries two asset codes:
 *
 *   - `tradedAssetCode` -- the asset the intent is buying or
 *     selling (e.g. `WBTC`). The orchestrator uses this for the
 *     local cross-candidate filter: a buy intent and a sell
 *     intent must trade the same asset to cross. This is the
 *     TEE's authoritative claim about what the envelope carries.
 *   - `assetCode` -- the asset the orchestrator should lock in
 *     `portfolios.locked`. For a buy intent, this is the
 *     settlement asset (typically `USDC`); for a sell intent, it
 *     is the same as `tradedAssetCode`.
 *
 * Splitting the two means the orchestrator can do its local
 * cross filter without ever decoding the envelope. The T3
 * enclave produces both values; the orchestrator carries them
 * through.
 */
export interface T3LockDescriptor {
  /**
   * Asset the intent is buying or selling. Authoritative on the
   * cross-candidate filter (buy and sell intents must trade the
   * same asset). The TEE has unsealed the envelope to produce
   * this; the orchestrator never sees the underlying trading
   * parameters.
   */
  tradedAssetCode: string;
  /**
   * Asset to reserve. For a buy intent, this is the settlement
   * asset (USDC). For a sell intent, this is the same as
   * `tradedAssetCode`.
   */
  assetCode: string;
  /**
   * TEE-attested intent side. The orchestrator uses this for
   * the local match filter (the buy side and sell side must
   * trade the same asset with opposite sides). The value is
   * NOT a wire-side plaintext leak -- it is the TEE's
   * authoritative claim about which side of the cross the
   * intent is on. The orchestrator never inspects the envelope
   * contents to derive this.
   */
  side: "buy" | "sell";
  /** Reservation amount. `quantity * price` for a buy; `quantity`
   * for a sell. */
  amount: number;
  /**
   * TEE-issued attestation reference. The portfolio service can
   * hand this to a TEE verifier to confirm the descriptor was
   * actually produced by the T3 enclave for this intent handle.
   * The orchestrator does not interpret the value; it just carries
   * it through.
   */
  attestationRef: string;
}
