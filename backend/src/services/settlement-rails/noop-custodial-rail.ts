import { createHash } from "node:crypto";
import type { SettlementCommand } from "../../enclave/index.js";
import type {
  RailSettlementProof,
  SettlementRail,
  SettlementRailContext,
  SettlementRailPlaintext,
} from "./rail.js";

/**
 * The default settlement rail. Synthesises a deterministic proof
 * for every match and does not move any assets on any external
 * transport. This is the rail that every existing
 * `settlementProfileRef` value (including the hard-coded
 * `"wallet:default"` in `auth.service.ts`) routes through today,
 * preserved as a typed rail.
 *
 * Behaviour matches the implicit "settle in DB only" path that
 * `SettlementService.executeSettlement` has had since the system
 * was built. The id `"wallet:default"` is the same string the
 * existing `institutions.settlement_profile_ref` column uses, so
 * no migration is needed.
 *
 * The `railTradeRef` is `noop:<sha256(outcomeRef)>` so that:
 *   1. A retry of `dispatch` with the same outcome returns the
 *      same proof (the dispatcher relies on this for idempotency).
 *   2. The proof is recognisable in the DB as a noop-rail proof.
 *   3. The proof contains no plaintext, so it is safe to surface
 *      in audit exports and the operator UI.
 */
export class NoopCustodialRail implements SettlementRail {
  public readonly id = "wallet:default";

  public async dispatch(
    command: SettlementCommand,
    _plaintext: SettlementRailPlaintext,
    _context?: SettlementRailContext,
  ): Promise<RailSettlementProof> {
    return {
      railId: this.id,
      railTradeRef: deriveNoopTradeRef(command.outcomeRef),
      // WS2.5: the noop rail has no on-chain transport,
      // so the signer address is `null`. The settlement
      // service reads this and emits a `rail_settled`
      // event without a TEE-attestation follow-up
      // (only the chain rail emits TEE-attestation
      // events).
      railSignerAddress: null,
      railState: "settled",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    };
  }

  public async reverse(
    tradeRef: string,
    _reason: string,
  ): Promise<RailSettlementProof> {
    // The noop rail has no external transport to reverse. A
    // reversal of a noop-rail trade is a DB-level state change
    // only; the rail's `reverse` is recorded as `reversed` so the
    // DB row can mirror that.
    return {
      railId: this.id,
      railTradeRef: tradeRef,
      // WS2.5: the noop rail's reverse is a no-op; no
      // on-chain signer.
      railSignerAddress: null,
      railState: "reversed",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    };
  }
}

/**
 * Derive a deterministic, content-addressed proof id for a noop
 * settlement. Visible to operators in the audit table; no
 * information leak (the hash is one-way and the input is a TEE
 * outcome ref).
 */
export function deriveNoopTradeRef(outcomeRef: string): string {
  const digest = createHash("sha256").update(`noop-rail:${outcomeRef}`).digest("hex");
  return `noop:${digest}`;
}
