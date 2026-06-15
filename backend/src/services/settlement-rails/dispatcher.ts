import { NoopCustodialRail } from "./noop-custodial-rail.js";
import { RailDispatchError } from "./rail-dispatch-error.js";
import type {
  SettlementRail,
  SettlementRailContext,
  SettlementRailPlaintext,
} from "./rail.js";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";

/**
 * Routes an institution's `settlementProfileRef` to a concrete
 * `SettlementRail` instance. The noop rail is the universal
 * fallback — every unknown profile is served by it, so a typo in a
 * profile string can never block settlement. The institution's
 * profile is still surfaced in the error so the operator can see
 * what they asked for.
 *
 * The dispatcher is built at boot time and held by the
 * `SettlementService`. Future WS2/WS3 work will register the chain
 * rail and the custody rail here. The interface is intentionally
 * stable: `SettlementService` only depends on
 * `dispatch(settlementProfileRef, command, plaintext, context)`.
 */
export interface SettlementRailDispatcher {
  /**
   * Resolve the rail for a given `settlementProfileRef`. Returns
   * the noop rail for unknown profiles (and emits no warning — the
   * profile is part of the audit trail via the returned rail's
   * `id`).
   */
  resolve(settlementProfileRef: string): SettlementRail;

  /**
   * Dispatch a settlement through the rail selected by
   * `settlementProfileRef`. Returns the rail's transport proof
   * wrapped in `{ settlementProfileRef, proof }` so the caller
   * has both the original selection string and the rail's view.
   *
   * Throws `RailDispatchError` if the rail throws. Network,
   * signing, and balance errors from the rail all flow through
   * this error type.
   */
  dispatch(
    settlementProfileRef: string,
    command: SettlementCommand,
    plaintext: SettlementRailPlaintext,
    context?: SettlementRailContext,
  ): Promise<{
    settlementProfileRef: string;
    proof: Awaited<ReturnType<SettlementRail["dispatch"]>>;
  }>;
}

/**
 * Build a dispatcher from a `Map<profileRef, rail>`. The map is
 * copied defensively; the caller cannot mutate the dispatcher's
 * registry after construction.
 *
 * Missing profile → noop rail (the documented fallback). The
 * `noopCustodialRail` instance passed in is also used as the
 * fallback so we do not allocate a second copy.
 */
export class MapSettlementRailDispatcher implements SettlementRailDispatcher {
  private readonly rails: ReadonlyMap<string, SettlementRail>;
  private readonly noopRail: SettlementRail;

  public constructor(
    rails: ReadonlyMap<string, SettlementRail>,
    noopRail: SettlementRail = new NoopCustodialRail(),
  ) {
    // Defensive copy + add the noop rail as a guaranteed fallback
    // for any profile not explicitly registered.
    const map = new Map<string, SettlementRail>(rails);
    if (!map.has(noopRail.id)) {
      map.set(noopRail.id, noopRail);
    }
    this.rails = map;
    this.noopRail = noopRail;
  }

  public resolve(settlementProfileRef: string): SettlementRail {
    return this.rails.get(settlementProfileRef) ?? this.noopRail;
  }

  public async dispatch(
    settlementProfileRef: string,
    command: SettlementCommand,
    plaintext: SettlementRailPlaintext,
    context?: SettlementRailContext,
  ): Promise<{
    settlementProfileRef: string;
    proof: Awaited<ReturnType<SettlementRail["dispatch"]>>;
  }> {
    const rail = this.resolve(settlementProfileRef);
    try {
      const proof = await rail.dispatch(command, plaintext, context);
      return { settlementProfileRef, proof };
    } catch (cause) {
      throw new RailDispatchError({
        settlementProfileRef,
        railId: rail.id,
        message: `Settlement rail '${rail.id}' failed for profile '${settlementProfileRef}': ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      });
    }
  }
}
