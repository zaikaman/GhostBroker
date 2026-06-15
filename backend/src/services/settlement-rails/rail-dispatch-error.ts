/**
 * Typed error raised by the settlement-rails dispatcher when the
 * selected rail cannot service a settlement call. Carries the
 * `settlementProfileRef` and the underlying rail's error so the
 * settlement service can map it to a public error code.
 *
 * This is the only error a rail is expected to throw in normal
 * operation. Rail implementations may throw any error; the
 * settlement service wraps unexpected errors in this type before
 * surfacing.
 */
export class RailDispatchError extends Error {
  public readonly settlementProfileRef: string;
  public readonly railId: string | undefined;
  public override readonly cause: unknown;

  public constructor(params: {
    settlementProfileRef: string;
    railId?: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "RailDispatchError";
    this.settlementProfileRef = params.settlementProfileRef;
    this.railId = params.railId;
    this.cause = params.cause;
  }
}
