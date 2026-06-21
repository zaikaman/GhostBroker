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
  /**
   * The admitted agent's record UUID (`agents.id`). Required so the
   * backend can run `loadAndVerify` against the persisted
   * Ghostbroker delegation W3C VC on `agents.metadata.delegation_credential`.
   * The agent learns its own `agentId` from the admit response and
   * echoes it back on every privileged call; the backend never
   * has to trust agent-supplied DID strings alone.
   */
  agentId: z.string().uuid(),
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
  /**
   * The admitted agent's record UUID. Required for the backend to
   * run `loadAndVerify` against the persisted delegation VC.
   * Cancel must be authorized as `intent.submit` (same VC scope);
   * the agentId is what the facade looks the VC up by.
   */
  agentId: z.string().uuid(),
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
  /** The admitted agent's record UUID. The settlement command builder
   *  uses this to run `loadAndVerify` against the persisted VC. */
  agentId: string;
  agentDid: string;
  intentHandle: string;
  executionRef: string;
  encryptedEnvelope: string;
  authorityRef: string;
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
 * TEE-attested balance-lock claim. The asset code, amount,
 * side, quantity, and price here are NOT plaintext trading
 * parameters that the orchestrator had to decode from the
 * envelope — they are the per-side TEE-attested claim
 * produced by `seal-intent` v0.8.0+ after it unsealed the
 * envelope inside the enclave. The orchestrator carries the
 * descriptor through to the portfolio service for the SQL
 * reservation and to the matching orchestrator as the
 * canonical source of the per-side `quantity` / `price`
 * fields the `evaluate-match` wire form consumes.
 *
 * The descriptor carries two asset codes:
 *
 *   - `tradedAssetCode` -- the asset the intent is buying or
 *     selling (e.g. `WBTC`). The orchestrator uses this for
 *     the local cross-candidate filter and as the
 *     `asset_code` field on the `evaluate-match` wire form.
 *     For a buy intent and a sell intent to cross they must
 *     trade the same asset. This is the TEE's authoritative
 *     claim about what the envelope carries.
 *   - `assetCode` -- the asset the orchestrator should lock
 *     in `portfolios.locked`. For a buy intent, this is the
 *     settlement asset (typically `USDC`); for a sell intent,
 *     it is the same as `tradedAssetCode`.
 *
 * Splitting the two means the orchestrator can do its local
 * cross filter without ever decoding the envelope. The T3
 * enclave produces all values; the orchestrator carries them
 * through.
 */
export interface T3LockDescriptor {
  /**
   * Asset the intent is buying or selling. Authoritative on
   * the cross-candidate filter (buy and sell intents must
   * trade the same asset) and the `asset_code` field on the
   * `evaluate-match` wire form. The TEE has unsealed the
   * envelope to produce this; the orchestrator never sees
   * the underlying trading parameters.
   */
  tradedAssetCode: string;
  /**
   * Asset to reserve. For a buy intent, this is the
   * settlement asset (USDC). For a sell intent, it is the
   * same as `tradedAssetCode`.
   */
  assetCode: string;
  /**
   * TEE-attested intent side. The orchestrator uses this for
   * the local match filter (the buy side and sell side must
   * trade the same asset with opposite sides). The value is
   * NOT a wire-side plaintext leak -- it is the TEE's
   * authoritative claim about which side of the cross the
   * intent is on. The orchestrator never inspects the
   * envelope contents to derive this.
   */
  side: "buy" | "sell";
  /**
   * TEE-attested intent quantity. Decimal string at the
   * contract's implicit `WIRE_SCALE` (1e18) so the value
   * flows directly into the `evaluate-match` `quantity` wire
   * field without a re-scale step. The orchestrator carries
   * this through on the match call.
   */
  quantity: string;
  /**
   * TEE-attested intent price (decimal string at the
   * contract's implicit `WIRE_SCALE`). Same rationale as
   * `quantity`.
   */
  price: string;
  /**
   * Reservation amount. `quantity * price` for a buy;
   * `quantity` for a sell. Equivalent to multiplying the
   * two scaled values and re-formatting at the wire scale.
   * The orchestrator carries this through to the portfolio
   * service for the SQL reservation.
   */
  amount: number;
  /**
   * TEE-issued attestation reference. The portfolio service
   * can hand this to a TEE verifier to confirm the
   * descriptor was actually produced by the T3 enclave for
   * this intent handle. The orchestrator does not interpret
   * the value; it just carries it through.
   */
  attestationRef: string;
}
