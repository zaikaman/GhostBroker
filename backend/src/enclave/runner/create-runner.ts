import type { T3NetworkClient } from "../sandbox/t3n-client.js";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import { RunnerLifecycle } from "./lifecycle.js";

export interface T3RunnerConfig {
  tenantDid: string;
  sandboxTokenAccount: string;
  minimumTokenBalance: bigint;
}

export interface T3RunnerDependencies {
  networkClient: T3NetworkClient;
  tokenBalanceClient: TokenBalanceClient;
  lifecycle?: RunnerLifecycle;
}

export interface T3Runner {
  readonly lifecycle: RunnerLifecycle;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createT3Runner(
  config: T3RunnerConfig,
  dependencies: T3RunnerDependencies,
): T3Runner {
  const lifecycle = dependencies.lifecycle ?? new RunnerLifecycle();

  return {
    lifecycle,
    async start(): Promise<void> {
      lifecycle.transition("connecting");
      await dependencies.tokenBalanceClient.assertMinimumBalance(
        config.sandboxTokenAccount,
        config.minimumTokenBalance,
      );
      await dependencies.networkClient.request({
        method: "POST",
        path: "/runner/session",
        body: { tenantDid: config.tenantDid },
      });
      lifecycle.transition("ready");
    },
    async stop(): Promise<void> {
      lifecycle.transition("draining");
      await dependencies.networkClient.request({
        method: "POST",
        path: "/runner/session/close",
        body: { tenantDid: config.tenantDid },
      });
      lifecycle.transition("stopped");
    },
  };
}
