export type RunnerLifecycleState =
  | "created"
  | "connecting"
  | "ready"
  | "draining"
  | "stopped"
  | "failed";

export interface RunnerLifecycleSnapshot {
  state: RunnerLifecycleState;
  updatedAt: string;
  failureReason?: string;
  consensusRetryCount?: number;
}

export class RunnerLifecycle {
  private snapshot: RunnerLifecycleSnapshot;

  public constructor(now: () => Date = () => new Date()) {
    this.snapshot = {
      state: "created",
      updatedAt: now().toISOString(),
    };
  }

  public current(): RunnerLifecycleSnapshot {
    return { ...this.snapshot };
  }

  public transition(
    state: RunnerLifecycleState,
    options: { now?: Date; failureReason?: string } = {},
  ): RunnerLifecycleSnapshot {
    const updated: RunnerLifecycleSnapshot = {
      state,
      updatedAt: (options.now ?? new Date()).toISOString(),
    };

    if (options.failureReason) {
      updated.failureReason = options.failureReason;
    }

    this.snapshot = updated;
    return this.current();
  }

  public recordConsensusConflict(
    options: { maxRetries: number; now?: Date } = { maxRetries: 3 },
  ): RunnerLifecycleSnapshot {
    const retryCount = (this.snapshot.consensusRetryCount ?? 0) + 1;

    if (retryCount > options.maxRetries) {
      const transitionOptions: { now?: Date; failureReason?: string } = {
        failureReason: "t3_consensus_conflict_retry_exhausted",
      };

      if (options.now) {
        transitionOptions.now = options.now;
      }

      return this.transition("failed", {
        ...transitionOptions,
      });
    }

    this.snapshot = {
      ...this.snapshot,
      state: "ready",
      updatedAt: (options.now ?? new Date()).toISOString(),
      consensusRetryCount: retryCount,
    };
    return this.current();
  }
}
