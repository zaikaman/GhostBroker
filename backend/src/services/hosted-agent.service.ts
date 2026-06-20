import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { issueOperatorSessionToken } from "../auth/session-token.js";
import { PublicError } from "../errors/public-error.js";
import {
  type CreateHostedAgentRequest,
  type HostedAgentRecord,
  type HostedAgentRuntimeStatus,
  type HostedNegotiatorRuntimeConfig,
  hasLegacyHostedAgentConfig,
  readHostedNegotiatorRuntimeConfig,
  toNegotiationMandateSummary,
} from "../models/hosted-agent.js";
import type { AgentManagementService } from "./agent.service.js";
import type { InstitutionManagementService } from "./institution.service.js";
import type { InstitutionApprovalService } from "./institution-approval.service.js";
import type { NegotiationManagementService } from "./negotiation.service.js";
import type { NegotiationMandate } from "../models/negotiation.js";

const LOG_TAIL_BYTES = 8192;
const HOSTED_SESSION_BUFFER_SECONDS = 15 * 60;
const HOSTED_SESSION_MINIMUM_SECONDS = 30 * 60;

interface HostedAgentRuntimeState {
  agentId: string;
  institutionId: string;
  child: ChildProcess | undefined;
  startedAt: string | undefined;
  stoppedAt: string | undefined;
  lastExitCode: number | undefined;
  lastSignal: string | undefined;
  sessionExpiresAt: string | undefined;
  lastError: string | undefined;
  logTail: string;
}

export interface HostedAgentManagementService {
  createHostedAgent(input: CreateHostedAgentRequest): Promise<HostedAgentRecord>;
  listHostedAgents(institutionId: string, running?: boolean): Promise<HostedAgentRecord[]>;
  getHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord>;
  startHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord>;
  stopHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord>;
  stopAllHostedAgents(): Promise<void>;
}

export interface ChildProcessHostedAgentServiceOptions {
  agentsDir: string;
  backendUrl: string;
  authSessionSecret: string;
  agentService: AgentManagementService;
  institutionService: Required<Pick<InstitutionManagementService, "getInstitution">>;
  negotiationService: Pick<
    NegotiationManagementService,
    "getMandateByAgent" | "listMandatesByAgent"
  >;
  institutionApprovalService?: InstitutionApprovalService;
  runner?: readonly string[];
  hostedScript?: string;
}

export class ChildProcessHostedAgentService implements HostedAgentManagementService {
  private readonly runtimeStates = new Map<string, HostedAgentRuntimeState>();
  private readonly agentsDir: string;
  private readonly backendUrl: string;
  private readonly authSessionSecret: string;
  private readonly agentService: AgentManagementService;
  private readonly institutionService: Required<Pick<InstitutionManagementService, "getInstitution">>;
  private readonly negotiationService: Pick<
    NegotiationManagementService,
    "getMandateByAgent" | "listMandatesByAgent"
  >;
  private readonly institutionApprovalService: InstitutionApprovalService | undefined;
  private readonly runner: readonly string[];
  private readonly hostedScript: string | undefined;

  public constructor(options: ChildProcessHostedAgentServiceOptions) {
    this.agentsDir = resolve(options.agentsDir);
    this.backendUrl = options.backendUrl;
    this.authSessionSecret = options.authSessionSecret;
    this.agentService = options.agentService;
    this.institutionService = options.institutionService;
    this.negotiationService = options.negotiationService;
    this.institutionApprovalService = options.institutionApprovalService;
    this.runner = options.runner ?? ["npm", "run"];
    this.hostedScript = options.hostedScript;
  }

  public async createHostedAgent(input: CreateHostedAgentRequest): Promise<HostedAgentRecord> {
    await this.assertSettlementReady(input.institutionId);
    const admittedAgent = await this.agentService.getAgent(input.agentId, input.institutionId);
    if (admittedAgent.status !== "admitted") {
      throw new PublicError(
        "validation_failed",
        422,
        undefined,
        "Hosted negotiators can only be attached to admitted agents.",
      );
    }

    const mandate = await this.requireMandate(input.institutionId, admittedAgent.id, input.config.mandateId);

    if (!this.agentService.updateAgentMetadata) {
      throw new PublicError(
        "service_unavailable",
        503,
        "updateAgentMetadata is not supported by this agent service implementation.",
      );
    }

    await this.agentService.updateAgentMetadata({
      id: admittedAgent.id,
      institutionId: input.institutionId,
      patch: {
        hostedAgent: input.config,
        hostedNegotiator: {
          mandateSnapshot: toNegotiationMandateSummary(mandate),
          migrationState: "ready",
        },
      },
    });

    if (input.startOnCreate) {
      return this.startHostedAgent(admittedAgent.id, input.institutionId);
    }

    return this.getHostedAgent(admittedAgent.id, input.institutionId);
  }

  public async listHostedAgents(
    institutionId: string,
    running?: boolean,
  ): Promise<HostedAgentRecord[]> {
    const agents = await this.agentService.listAgents(institutionId, "admitted");
    const hosted = await Promise.all(agents.map(async (agent) => this.toHostedRecord(agent)));
    const filtered = hosted.filter((record): record is HostedAgentRecord => record !== null);

    if (running === undefined) {
      return filtered;
    }
    return filtered.filter((record) => record.runtime.running === running);
  }

  public async getHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord> {
    const agent = await this.agentService.getAgent(id, institutionId);
    const record = await this.toHostedRecord(agent);
    if (!record) {
      throw new PublicError("not_found", 404);
    }
    return record;
  }

  public async startHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord> {
    await this.assertSettlementReady(institutionId);
    const record = await this.getHostedAgent(id, institutionId);
    if (record.migrationState === "needs_migration") {
      throw new PublicError(
        "validation_failed",
        422,
        undefined,
        "Legacy deploy config detected. Attach a negotiation mandate to relaunch.",
      );
    }
    if (!record.config || !record.mandate) {
      throw new PublicError(
        "validation_failed",
        422,
        undefined,
        "Hosted negotiator requires an active mandate before launch.",
      );
    }

    const existingState = this.runtimeStates.get(id);
    if (existingState?.child && existingState.child.exitCode === null) {
      const pid = existingState.child.pid;
      console.log(
        `[HOSTED] start request for agent ${id} ignored — runtime already running (pid=${pid ?? "unknown"}, startedAt=${existingState.startedAt ?? "unknown"})`,
      );
      return this.getHostedAgent(id, institutionId);
    }

    const institution = await this.institutionService.getInstitution(institutionId);
    const sessionExpiresAt = new Date(
      Date.now() + this.computeHostedSessionTtlMs(record.config),
    ).toISOString();
    const sessionToken = issueOperatorSessionToken({
      secret: this.authSessionSecret,
      did: record.agent.agentDid,
      institutionId,
      ttlSeconds: Math.ceil(
        (new Date(sessionExpiresAt).getTime() - Date.now()) / 1000,
      ),
    });

    const child = this.spawnHostedAgent(
      {
        agentDid: record.agent.agentDid,
        agentId: id,
        config: record.config,
      },
      {
        token: sessionToken,
        expiresAt: sessionExpiresAt,
        institutionId: institution.id,
        displayName: institution.displayName,
        tenantDid: institution.t3TenantDid,
      },
    );
    // The settlement readiness check (assertSettlementReady above) is
    // what makes `settlement_capacity` a pre-launch readiness fact,
    // not a per-round negotiated claim. Log the pre-clear so the
    // demo narrative stays honest.
    console.log(
      `[HOSTED] settlement pre-clear: deposit relayer approvals verified for ${institution.displayName}; launching runtime (pollIntervalMs=${record.config.pollIntervalMs}, maxTicks=${record.config.maxTicks})`,
    );
    const state: HostedAgentRuntimeState = {
      agentId: id,
      institutionId,
      child,
      startedAt: new Date().toISOString(),
      stoppedAt: undefined,
      lastExitCode: undefined,
      lastSignal: undefined,
      sessionExpiresAt,
      lastError: undefined,
      logTail: "",
    };

    this.attachLogTail(child, state);
    child.on("exit", (code, signal) => {
      const current = this.runtimeStates.get(id);
      if (!current) return;
      current.child = undefined;
      current.stoppedAt = new Date().toISOString();
      current.lastExitCode = code === null ? undefined : code;
      current.lastSignal = signal ?? undefined;
      if ((code ?? 0) !== 0) {
        current.lastError = `Process exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`;
      }
    });
    child.on("error", (error) => {
      const current = this.runtimeStates.get(id);
      if (!current) return;
      current.lastError = error.message;
    });

    this.runtimeStates.set(id, state);
    return this.getHostedAgent(id, institutionId);
  }

  public async stopHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord> {
    await this.getHostedAgent(id, institutionId);
    const state = this.runtimeStates.get(id);
    if (!state) {
      return this.getHostedAgent(id, institutionId);
    }

    const child = state.child;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveStop) => setTimeout(resolveStop, 1000));
      const currentChild = state.child;
      if (currentChild && currentChild.exitCode === null) {
        currentChild.kill("SIGKILL");
      }
    }

    state.child = undefined;
    state.stoppedAt = new Date().toISOString();
    return this.getHostedAgent(id, institutionId);
  }

  public async stopAllHostedAgents(): Promise<void> {
    const states = [...this.runtimeStates.values()];
    for (const state of states) {
      try {
        await this.stopHostedAgent(state.agentId, state.institutionId);
      } catch {
        // best effort
      }
    }
  }

  private async toHostedRecord(
    agent: Awaited<ReturnType<AgentManagementService["getAgent"]>>,
  ): Promise<HostedAgentRecord | null> {
    const runtimeConfig = readHostedNegotiatorRuntimeConfig(agent);
    const legacy = hasLegacyHostedAgentConfig(agent);
    const hasHostedMetadata = runtimeConfig !== null || legacy;
    if (!hasHostedMetadata) {
      return null;
    }

    const mandate = await this.loadMandateForRecord(agent.institutionId, agent.id, runtimeConfig?.mandateId);
    return {
      agent,
      config: runtimeConfig,
      runtime: this.readRuntimeState(agent.id),
      mandate: mandate ? toNegotiationMandateSummary(mandate) : null,
      migrationState: legacy || !runtimeConfig || !mandate ? "needs_migration" : "ready",
    };
  }

  private async loadMandateForRecord(
    institutionId: string,
    agentId: string,
    mandateId?: string,
  ): Promise<NegotiationMandate | null> {
    const active = await this.negotiationService.getMandateByAgent(institutionId, agentId);
    if (!active) {
      return null;
    }
    if (!mandateId || active.id === mandateId) {
      return active;
    }
    const mandates = await this.negotiationService.listMandatesByAgent(institutionId, agentId);
    return mandates.find((item) => item.id === mandateId) ?? active;
  }

  private async requireMandate(
    institutionId: string,
    agentId: string,
    mandateId: string,
  ): Promise<NegotiationMandate> {
    const mandate = await this.loadMandateForRecord(institutionId, agentId, mandateId);
    if (!mandate || mandate.id !== mandateId) {
      throw new PublicError(
        "validation_failed",
        422,
        undefined,
        "Hosted negotiator requires an active mandate before launch.",
      );
    }
    return mandate;
  }

  private readRuntimeState(agentId: string): HostedAgentRuntimeStatus {
    const state = this.runtimeStates.get(agentId);
    if (!state) {
      return {
        running: false,
        pid: undefined,
        startedAt: undefined,
        stoppedAt: undefined,
        lastExitCode: undefined,
        lastSignal: undefined,
        sessionExpiresAt: undefined,
        lastError: undefined,
        logTail: "",
      };
    }

    return {
      running: Boolean(state.child && state.child.exitCode === null),
      pid: state.child?.pid,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      lastExitCode: state.lastExitCode,
      lastSignal: state.lastSignal,
      sessionExpiresAt: state.sessionExpiresAt,
      lastError: state.lastError,
      logTail: state.logTail,
    };
  }

  private async assertSettlementReady(institutionId: string): Promise<void> {
    const institution = await this.institutionService.getInstitution(institutionId);

    if (institution.settlementProfileRef !== "chain:sepolia:erc20") {
      return;
    }

    if (!this.institutionApprovalService) {
      throw new PublicError(
        "service_unavailable",
        503,
        undefined,
        "Settlement readiness checks are unavailable. Hosted agents cannot launch until deposit wallet approval status can be verified.",
      );
    }

    const depositStatus = await this.institutionApprovalService.getDepositStatus(institutionId);
    if (depositStatus.approved.wbtc && depositStatus.approved.usdc) {
      return;
    }

    throw new PublicError(
      "validation_failed",
      422,
      undefined,
      "Approve the settlement relayer for both WBTC and USDC in Settings before deploying or starting hosted agents.",
    );
  }

  private computeHostedSessionTtlMs(config: HostedNegotiatorRuntimeConfig): number {
    const sessionWindowMs =
      config.pollIntervalMs * config.maxTicks +
      HOSTED_SESSION_BUFFER_SECONDS * 1000;
    return Math.max(sessionWindowMs, HOSTED_SESSION_MINIMUM_SECONDS * 1000);
  }

  private spawnHostedAgent(
    runtime: {
      agentDid: string;
      agentId: string;
      config: HostedNegotiatorRuntimeConfig;
    },
    session: {
      token: string;
      expiresAt: string;
      institutionId: string;
      displayName: string;
      tenantDid: string;
    },
  ): ChildProcess {
    const isScriptMode = this.hostedScript !== undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GHOSTBROKER_URL: this.backendUrl,
      GHOSTBROKER_SESSION_TOKEN: session.token,
      GHOSTBROKER_SESSION_EXPIRES_AT: session.expiresAt,
      GHOSTBROKER_INSTITUTION_ID: session.institutionId,
      GHOSTBROKER_INSTITUTION_DISPLAY_NAME: session.displayName,
      GHOSTBROKER_INSTITUTION_TENANT_DID: session.tenantDid,
      AGENT_IDENTITY_DID: runtime.agentDid,
      HOSTED_AGENT_ID: runtime.agentId,
      HOSTED_MANDATE_ID: runtime.config.mandateId,
      POLL_INTERVAL_MS: String(runtime.config.pollIntervalMs),
      MAX_TICKS: String(runtime.config.maxTicks),
      DRY_RUN: runtime.config.dryRun ? "true" : "false",
      // LLM provider credentials are deliberately NOT forwarded from
      // the backend's environment. The hosted agent reads them from
      // agents/.env via loadDotEnv(). This ensures a fresh dev setup
      // works without needing to set these vars in the backend's shell
      // or worry about stale backend env vars overriding the agent's
      // .env (which is the canonical source for agent LLM keys).
      // We also clear any *_BASE_URL the backend may have set so the
      // hosted agent can never silently inherit a stale third-party
      // proxy — agents MUST ship an explicit *_BASE_URL in their own
      // .env (the agent env loader treats .env values as defaults that
      // do not override anything already set; clearing them here
      // forces a fresh read from agents/.env on every spawn).
      GEMINI_API_KEY: undefined,
      GEMINI_MODEL: undefined,
      GEMINI_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_MODEL: undefined,
      OPENAI_BASE_URL: undefined,
      GROQ_API_KEY: undefined,
      GROQ_MODEL: undefined,
      GROQ_BASE_URL: undefined,
    };
    const isWin = process.platform === "win32";
    const shell = isWin && this.runner[0] === "npm";

    const runnerBin = this.runner[0];
    if (!runnerBin) {
      throw new PublicError("service_unavailable", 503, "Runner command is not configured.");
    }
    const runnerArgs = [...this.runner.slice(1)];

    if (isScriptMode && this.hostedScript) {
      console.log(
        `[HOSTED] spawning ${runnerBin} ${[...runnerArgs, this.hostedScript].join(" ")} (cwd=${this.agentsDir}, shell=${shell})`,
      );
      const child = spawn(runnerBin, [...runnerArgs, this.hostedScript], {
        cwd: this.agentsDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell,
      });
      this.attachDiagnostics(child, runtime.agentId);
      return child;
    }

    console.log(
      `[HOSTED] spawning ${runnerBin} ${[...runnerArgs, "hosted"].join(" ")} (cwd=${this.agentsDir}, shell=${shell})`,
    );
    const child = spawn(runnerBin, [...runnerArgs, "hosted"], {
      cwd: this.agentsDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
    });
    this.attachDiagnostics(child, runtime.agentId);
    return child;
  }

  private attachDiagnostics(child: ChildProcess, agentId: string): void {
    child.on("error", (error) => {
      console.error(`[HOSTED] spawn error for agent ${agentId}: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if ((code ?? 0) !== 0) {
        console.error(
          `[HOSTED] agent ${agentId} runtime exited code=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""}`,
        );
      } else {
        console.log(`[HOSTED] agent ${agentId} runtime exited cleanly`);
      }
    });
  }

  private attachLogTail(proc: ChildProcess, state: HostedAgentRuntimeState): void {
    const append = (chunk: Buffer | string): void => {
      state.logTail = (state.logTail + chunk.toString("utf8")).slice(-LOG_TAIL_BYTES);
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
  }
}
