import { RailDispatchError } from "./rail-dispatch-error.js";
import type {
  SettlementRail,
  SettlementRailContext,
  SettlementRailPlaintext,
} from "./rail.js";
import type { SettlementCommand } from "../../enclave/index.js";

/**
 * Routes an institution's `settlementProfileRef` to a concrete
 * `SettlementRail` instance.
 *
 * GhostBroker exposes a single settlement rail — `chain:sepolia:erc20`
 * — registered at boot time in `app.ts`. The dispatcher is a thin
 * `Map<profileRef, rail>` lookup: the profile ref is the rail's `id`
 * 1:1, so the rail registry has exactly one entry. Any profile ref
 * that is not registered produces a `RailDispatchError` so a typo
 * or stale profile cannot silently fall through to a non-existent
 * rail. The institution's profile is surfaced in the error so the
 * operator can see what they asked for.
 *
 * The dispatcher is built at boot time and held by the
 * `SettlementService`. The interface is intentionally stable:
 * `SettlementService` only depends on
 * `dispatch(settlementProfileRef, command, plaintext, context)`.
 */
export interface SettlementRailDispatcher {
  /**
   * Resolve the rail for a given `settlementProfileRef`. Throws
   * `RailDispatchError` if the profile is not registered; the rail
   * registry has exactly one entry (`chain:sepolia:erc20`) so the
   * only "unknown" profiles are typos or pre-migration legacy
   * values.
   */
  resolve(settlementProfileRef: string): SettlementRail;

  /**
   * Dispatch a settlement through the rail selected by
   * `settlementProfileRef`. Returns the rail's transport proof
   * wrapped in `{ settlementProfileRef, proof }` so the caller
   * has both the original selection string and the rail's view.
   *
   * Throws `RailDispatchError` if the rail throws or the profile
   * is not registered. Network, signing, and balance errors from
   * the rail all flow through this error type.
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
 * Missing profile → `RailDispatchError`. There is no fallback
 * rail: the system exposes exactly one settlement rail
 * (`chain:sepolia:erc20`) and a settlement with an unknown
 * profile must fail loudly.
 */
export class MapSettlementRailDispatcher implements SettlementRailDispatcher {
  private readonly rails: ReadonlyMap<string, SettlementRail>;

  public constructor(rails: ReadonlyMap<string, SettlementRail>) {
    this.rails = new Map(rails);
  }

  public resolve(settlementProfileRef: string): SettlementRail {
    const rail = this.rails.get(settlementProfileRef);
    if (!rail) {
      throw new RailDispatchError({
        settlementProfileRef,
        railId: settlementProfileRef,
        message:
          `Settlement rail '${settlementProfileRef}' is not registered. ` +
          `GhostBroker exposes a single rail, 'chain:sepolia:erc20'.`,
      });
    }
    return rail;
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
    let rail: SettlementRail;
    try {
      rail = this.resolve(settlementProfileRef);
    } catch (error) {
      if (error instanceof RailDispatchError) {
        throw error;
      }
      throw new RailDispatchError({
        settlementProfileRef,
        railId: settlementProfileRef,
        message: `Settlement rail '${settlementProfileRef}' could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cause: error,
      });
    }
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
