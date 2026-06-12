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
}
