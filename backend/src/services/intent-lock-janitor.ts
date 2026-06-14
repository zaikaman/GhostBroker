import type { TelemetryBus } from "./telemetry-bus.js";
import type { IntentLockRepository } from "./intent-lock-repository.js";
import type { PortfolioService } from "./portfolio.service.js";

/** Default sweep interval: 30 seconds. */
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * Default intent TTL: 5 minutes. A lock ref older than this
 * is considered orphaned (the matching orchestrator is in-memory
 * and would have evicted the intent from its queue well before
 * this if the orchestrator was alive).
 */
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * The orphan-lock janitor.
 *
 * The matching orchestrator's pending-queue is in-memory. When
 * a process restarts, the queue is gone but the corresponding
 * `portfolios.locked` amounts are not. The `intent_locks` table
 * (see migration 011) tracks which locks are backed by a real
 * intent; this service scans for rows older than the intent TTL
 * and releases the corresponding lock amounts. That is the
 * durable recovery path for the Gap 7 reservations.
 *
 * Sweep design:
 *
 * - The janitor runs every 30 seconds. 30s is short enough that
 *   a forgotten lock is recovered within a minute of TTL expiry
 *   in the worst case, and long enough that a busy system with
 *   1000+ locks doesn't hammer the database.
 *
 * - The cutoff is `now() - LOCK_TTL_MS`. A live intent is at
 *   most `LOCK_TTL_MS` old, so any row older than the cutoff
 *   cannot have a live in-memory owner.
 *
 * - For each expired ref, the janitor calls
 *   `portfolioService.releaseBalance` (best-effort, never
 *   throws) and then `intentLockRepository.delete` (best-effort,
 *   never throws — the in-memory test client returns false on
 *   "not found" so a previously-deleted row doesn't crash the
 *   sweep).
 *
 * - The sweeper logs every action. Telemetry emission is
 *   intentionally not done on the hot path: a sweeper recovering
 *   a stale lock is an operational signal, not a user-visible
 *   event, and an operator would rather see it in logs than in
 *   the WebSocket stream.
 *
 * Idempotency: if the orchestrator's own eviction gets there
 * first (e.g., the orchestrator was alive for 5 minutes, then
 * died, and on the next start the sweeper runs while a new
 * intent is briefly orphaned), the orchestrator's
 * `releaseLockFor` + `deleteLockRefFor` runs first, then the
 * sweeper sees nothing. If the sweeper runs first, it releases
 * the lock (idempotent — `LEAST(locked - amount, 0)` clamps)
 * and tries to delete the ref (returns false on not-found,
 * logs and continues). The orchestrator's subsequent eviction
 * sees an empty queue and does nothing.
 */
export class IntentLockJanitor {
  private readonly intentLockRepository: IntentLockRepository;
  private readonly portfolioService: PortfolioService;
  private readonly telemetryBus: TelemetryBus | undefined;
  private readonly lockTtlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private sweptCount = 0;
  private lastSweepAt: string | null = null;

  public constructor(
    intentLockRepository: IntentLockRepository,
    portfolioService: PortfolioService,
    options?: {
      telemetryBus?: TelemetryBus;
      lockTtlMs?: number;
      sweepIntervalMs?: number;
    },
  ) {
    this.intentLockRepository = intentLockRepository;
    this.portfolioService = portfolioService;
    this.telemetryBus = options?.telemetryBus;
    this.lockTtlMs = options?.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;

    const sweepIntervalMs =
      options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(
      () => void this.sweep(),
      sweepIntervalMs,
    );
    // Allow the process to exit even if the interval is still
    // running. The janitor is best-effort and may be safely
    // skipped on shutdown.
    if (
      this.sweepTimer &&
      typeof this.sweepTimer === "object" &&
      "unref" in this.sweepTimer
    ) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Run a single sweep. Public so tests and operator tooling
   * can trigger one off-schedule.
   */
  public async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.lockTtlMs);
    let swept = 0;
    try {
      const expired =
        await this.intentLockRepository.findOlderThan(cutoff);

      for (const lock of expired) {
        try {
          // Release the actual lock amount. `releaseBalance`
          // is best-effort and never throws, but we still wrap
          // it in a try/catch for defensive depth — we don't
          // want a single bad row to abort the entire sweep.
          await this.portfolioService.releaseBalance(
            lock.institutionId,
            lock.assetCode,
            lock.amount,
          );
        } catch (error) {
          console.error(
            `[IntentLockJanitor] Failed to release ${lock.amount} ${lock.assetCode} for ${lock.institutionId}:`,
            error,
          );
          // Don't try to delete the ref if the release failed;
          // the next sweep will try again.
          continue;
        }

        try {
          await this.intentLockRepository.delete(lock.intentHandle);
        } catch (error) {
          console.error(
            `[IntentLockJanitor] Failed to delete lock ref for ${lock.intentHandle}:`,
            error,
          );
          // The release already happened; the next sweep will
          // try the release again (clamped at zero, so a
          // no-op) and then the delete.
        }

        swept++;
        if (this.telemetryBus) {
          this.telemetryBus.publish({
            institutionId: lock.institutionId,
            type: "telemetry.processing.changed",
            phase: "intent_lock_released",
            severity: "info",
            correlationRef: lock.correlationRef ?? lock.intentHandle,
            ...(lock.agentDid ? { agentId: lock.agentDid } : {}),
          });
        }
      }
    } catch (error) {
      console.error("[IntentLockJanitor] Sweep failed:", error);
    }

    this.sweptCount += swept;
    this.lastSweepAt = new Date().toISOString();
    return swept;
  }

  /**
   * Stop the periodic sweep timer. Call this on app shutdown.
   * The current in-flight sweep, if any, is allowed to complete
   * (we don't abort — `setInterval` doesn't support cancel of
   * an already-fired callback).
   */
  public stop(): void {
    clearInterval(this.sweepTimer);
  }

  public getSweptCount(): number {
    return this.sweptCount;
  }

  public getLastSweepAt(): string | null {
    return this.lastSweepAt;
  }
}
