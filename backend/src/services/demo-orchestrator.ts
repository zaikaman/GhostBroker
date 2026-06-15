import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { ApiKeyManagementService } from "./api-key.service.js";
import { PublicError } from "../errors/public-error.js";

/**
 * Owns the lifecycle of the Phase 2.5 demo agent child
 * processes.
 *
 * When the operator clicks "Spin up demo agents" on the
 * Observatory tab, the backend:
 *
 *   1. Mints a short-TTL per-institution API key via the
 *      existing `apiKeyService` (the key is scoped to one
 *      institution, has a 1-hour TTL by convention, and
 *      is revoked when the demo stops — see the route
 *      handler for the TTL/revocation policy).
 *   2. Spawns `npm run buyer` and `npm run seller` in the
 *      `agents/` workspace as child processes, with the
 *      demo API key + backend URL injected via env.
 *   3. Tracks the PIDs and the spawned-at timestamp so
 *      the status endpoint can report the running pair.
 *
 * On stop, the orchestrator kills both children, revokes
 * the demo API key, and clears the state. The orchestrator
 * is also wired into the backend shutdown path (in
 * `server.ts`) so an operator `SIGTERM` cleans up the
 * children on the way out.
 *
 * The orchestrator is one-shot per process: a second
 * `startDemo()` call without a `stopDemo()` in between
 * throws. The route handler enforces this with a 409.
 */
export interface DemoAgentOrchestrator {
  startDemo(input: {
    institutionId: string;
    /** Plaintext API key to inject into the spawned agents. */
    demoApiKey: string;
    /**
     * ID of the API key the route handler minted for this
     * demo run. Stored in state and revoked on `stopDemo()`.
     * The orchestrator does NOT mint its own key — the route
     * handler owns the key lifecycle.
     */
    apiKeyId: string;
    /**
     * Pre-configured agent DID for the buyer process.
     * Passed through as `AGENT_IDENTITY_DID` so the agent
     * uses the same DID the backend configured with a VC.
     */
    buyerAgentDid?: string;
    /**
     * Pre-configured agent DID for the seller process.
     * Same pattern as buyerAgentDid.
     */
    sellerAgentDid?: string;
  }): Promise<DemoStatus>;
  stopDemo(): Promise<DemoStatus>;
  getStatus(): DemoStatus;
}

export interface DemoStatus {
  running: boolean;
  buyerPid?: number | undefined;
  sellerPid?: number | undefined;
  startedAt?: string | undefined;
  institutionId?: string | undefined;
  apiKeyId?: string | undefined;
  buyerLogTail?: string | undefined;
  sellerLogTail?: string | undefined;
}

interface InternalState {
  buyer?: ChildProcess;
  seller?: ChildProcess;
  startedAt: string;
  institutionId: string;
  apiKeyId: string;
  buyerLogTail: string;
  sellerLogTail: string;
}

const LOG_TAIL_BYTES = 4096;

export interface ChildProcessDemoAgentOrchestratorOptions {
  agentsDir: string;
  backendUrl: string;
  apiKeyService: ApiKeyManagementService;
  /**
   * The command + args prefix used to launch each side.
   * Defaults to `["npm", "run"]` so the production
   * orchestrator runs `npm run buyer` / `npm run seller`
   * from the `agents/` workspace. Tests override to
   * `["node"]` and pass `buyerScript` / `sellerScript`
   * (absolute paths) so the test doesn't need `npm` on
   * PATH.
   */
  runner?: readonly string[];
  /**
   * Absolute path to the buyer / seller entry scripts.
   * Defaults to `undefined`, which means the runner
   * expects an `npm run`-style invocation with the side
   * name as the next arg.
   */
  buyerScript?: string;
  sellerScript?: string;
}

export class ChildProcessDemoAgentOrchestrator implements DemoAgentOrchestrator {
  private state: InternalState | undefined;
  private readonly agentsDir: string;
  private readonly backendUrl: string;
  private readonly apiKeyService: ApiKeyManagementService;
  private readonly runner: readonly string[];
  private readonly buyerScript: string | undefined;
  private readonly sellerScript: string | undefined;

  public constructor(options: ChildProcessDemoAgentOrchestratorOptions) {
    this.agentsDir = resolve(options.agentsDir);
    this.backendUrl = options.backendUrl;
    this.apiKeyService = options.apiKeyService;
    this.runner = options.runner ?? ["npm", "run"];
    this.buyerScript = options.buyerScript;
    this.sellerScript = options.sellerScript;
  }

  public async startDemo(input: {
    institutionId: string;
    demoApiKey: string;
    apiKeyId: string;
    buyerAgentDid?: string;
    sellerAgentDid?: string;
  }): Promise<DemoStatus> {
    if (this.state) {
      throw new PublicError("service_unavailable", 409);
    }
    if (!input.demoApiKey.startsWith("gbk_")) {
      throw new PublicError("validation_failed", 400);
    }

    // The route handler owns the API key lifecycle: it mints
    // the key before calling startDemo and passes the id so
    // we can revoke it on stop. We do NOT mint our own key
    // here — that would leak an unused credential.

    // The agent DIDs are generated server-side by
    // `AgentService.configureAgent()` which also mints
    // and persists the delegation VC. We pass the DIDs
    // through to the spawned processes via
    // `AGENT_IDENTITY_DID` so the agent re-uses the same
    // DID the backend configured.
    const buyer = this.spawnSide("buyer", input.demoApiKey, input.buyerAgentDid);
    const seller = this.spawnSide("seller", input.demoApiKey, input.sellerAgentDid);

    const state: InternalState = {
      buyer,
      seller,
      startedAt: new Date().toISOString(),
      institutionId: input.institutionId,
      apiKeyId: input.apiKeyId,
      buyerLogTail: "",
      sellerLogTail: "",
    };

    this.tailStream(buyer, "buyer", state);
    this.tailStream(seller, "seller", state);
    this.state = state;

    return this.getStatus();
  }

  public async stopDemo(): Promise<DemoStatus> {
    if (!this.state) {
      return this.getStatus();
    }
    const { buyer, seller, apiKeyId, institutionId } = this.state;
    // Soft-kill first, hard-kill after 1s. npm wraps the
    // tsx child so the PID we hold is the npm process; the
    // SIGTERM propagates to the tsx child naturally. On
    // Windows the kill signal is the same — `tree-kill`
    // is overkill for the npm→tsx chain (npm already
    // spawns the child in the same process group on POSIX;
    // on Windows `taskkill /T` would be needed but the
    // tsx child exits when stdin closes, which happens
    // when the parent npm dies).
    if (buyer && buyer.exitCode === null) {
      buyer.kill("SIGTERM");
    }
    if (seller && seller.exitCode === null) {
      seller.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 1_000));
    if (buyer && buyer.exitCode === null) {
      buyer.kill("SIGKILL");
    }
    if (seller && seller.exitCode === null) {
      seller.kill("SIGKILL");
    }
    // Revoke the demo API key so a leaked child stdout
    // capture can't be used to trade after the demo ends.
    try {
      await this.apiKeyService.revokeKey(apiKeyId, institutionId);
    } catch {
      // Revoke is best-effort; the TTL is the safety net
      // (the label + the post-demo sweep will catch any
      // orphan key on the next dashboard visit).
    }
    this.state = undefined;
    return this.getStatus();
  }

  public getStatus(): DemoStatus {
    if (!this.state) {
      return { running: false };
    }
    return {
      running: true,
      buyerPid: this.state.buyer?.pid,
      sellerPid: this.state.seller?.pid,
      startedAt: this.state.startedAt,
      institutionId: this.state.institutionId,
      apiKeyId: this.state.apiKeyId,
      buyerLogTail: this.state.buyerLogTail,
      sellerLogTail: this.state.sellerLogTail,
    };
  }

  /**
   * Build the `spawn()` argv + env for one side of the
   * demo. Two modes:
   *   - Default (`runner = ["npm", "run"]`): runs
   *     `npm run <side>` in the `agents/` workspace.
   *   - Test (`runner = ["node"]` + `buyerScript` /
   *     `sellerScript`): runs the script directly.
   * The env is built in `startDemo` and threaded through
   * unchanged.
   */
  private spawnSide(
    side: "buyer" | "seller",
    demoApiKey: string,
    agentDid?: string,
  ): ChildProcess {
    const isScriptMode =
      this.buyerScript !== undefined || this.sellerScript !== undefined;
    const script =
      side === "buyer" ? this.buyerScript : this.sellerScript;
    const env: NodeJS.ProcessEnv = {
      ...this.spawnEnv(demoApiKey),
      ...(agentDid ? { AGENT_IDENTITY_DID: agentDid } : {}),
    };
    const isWin = process.platform === "win32";
    const shell = isWin && this.runner[0] === "npm";

    if (isScriptMode && script) {
      return spawn(
        this.runner[0]!,
        [...this.runner.slice(1), script],
        {
          cwd: this.agentsDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell,
        },
      );
    }
    return spawn(
      this.runner[0]!,
      [...this.runner.slice(1), side],
      {
        cwd: this.agentsDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell,
      },
    );
  }

  private spawnEnv(demoApiKey: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GHOSTBROKER_URL: this.backendUrl,
      GHOSTBROKER_API_KEY: demoApiKey,
      // The agents workspace reads GROQ_API_KEY from its
      // own `.env`; the orchestrator passes through the
      // host's env so the spawned processes pick it up
      // automatically. If the operator hasn't set it,
      // the buyer/seller preflight will fail with a clear
      // error pointing at the env var.
    };
  }

  private tailStream(
    proc: ChildProcess,
    side: "buyer" | "seller",
    state: InternalState,
  ): void {
    const append = (chunk: Buffer | string): void => {
      const text = chunk.toString("utf8");
      const key = side === "buyer" ? "buyerLogTail" : "sellerLogTail";
      const next = (state[key] + text).slice(-LOG_TAIL_BYTES);
      if (side === "buyer") {
        state.buyerLogTail = next;
      } else {
        state.sellerLogTail = next;
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
  }
}
