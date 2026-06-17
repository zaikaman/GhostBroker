import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { issueOperatorSessionToken } from "../auth/session-token.js";
import { PublicError } from "../errors/public-error.js";
import {
  type CreateHostedAgentRequest,
  type HostedAgentConfig,
  type HostedAgentRecord,
  type HostedAgentRuntimeStatus,
  readHostedAgentConfig,
} from "../models/hosted-agent.js";
import type { AgentManagementService } from "./agent.service.js";
import type { InstitutionManagementService } from "./institution.service.js";
import type { TenantDelegationSigner } from "./tenant-delegation-signer.js";
import type { InstitutionApprovalService } from "./institution-approval.service.js";

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
  tenantSigner: TenantDelegationSigner;
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
  private readonly tenantSigner: TenantDelegationSigner;
  private readonly institutionApprovalService: InstitutionApprovalService | undefined;
  private readonly runner: readonly string[];
  private readonly hostedScript: string | undefined;

  public constructor(options: ChildProcessHostedAgentServiceOptions) {
    this.agentsDir = resolve(options.agentsDir);
    this.backendUrl = options.backendUrl;
    this.authSessionSecret = options.authSessionSecret;
    this.agentService = options.agentService;
    this.institutionService = options.institutionService;
    this.tenantSigner = options.tenantSigner;
    this.institutionApprovalService = options.institutionApprovalService;
    this.runner = options.runner ?? ["npm", "run"];
    this.hostedScript = options.hostedScript;
  }

  public async createHostedAgent(input: CreateHostedAgentRequest): Promise<HostedAgentRecord> {
    await this.assertSettlementReady(input.institutionId);
    const maxSpendUsd = Math.ceil(
      input.config.referencePrice *
        input.config.quantityMax *
        (1 + input.config.priceBandBps / 10_000),
    );

    const configured = await this.agentService.configureAgent({
      institutionId: input.institutionId,
      label: input.config.label,
      policy: {
        maxSpendUsd,
        allowedCategories: ["services"],
        purpose: `hosted ${input.config.side} ${input.config.assetCode}`,
        validityMonths: 12,
      },
      signCredential: async (policyInput) =>
        this.tenantSigner.mint({
          ...policyInput,
          allowedCategories: [...policyInput.allowedCategories],
        }),
    });

    if (!this.agentService.updateAgentMetadata) {
      throw new PublicError(
        "service_unavailable",
        503,
        "updateAgentMetadata is not supported by this agent service implementation.",
      );
    }
    const updated = await this.agentService.updateAgentMetadata({
      id: configured.agent.id,
      institutionId: input.institutionId,
      patch: {
        hostedAgent: input.config,
      },
    });

    if (input.startOnCreate) {
      return this.startHostedAgent(updated.id, input.institutionId);
    }

    const record = this.toHostedRecord(updated);
    if (!record) {
      throw new PublicError("service_unavailable", 503);
    }
    return record;
  }

  public async listHostedAgents(
    institutionId: string,
    running?: boolean,
  ): Promise<HostedAgentRecord[]> {
    const agents = await this.agentService.listAgents(institutionId, "admitted");
    const hosted = agents
      .map((agent) => this.toHostedRecord(agent))
      .filter((record): record is HostedAgentRecord => record !== null);

    if (running === undefined) {
      return hosted;
    }
    return hosted.filter((record) => record.runtime.running === running);
  }

  public async getHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord> {
    const agent = await this.agentService.getAgent(id, institutionId);
    const record = this.toHostedRecord(agent);
    if (!record) {
      throw new PublicError("not_found", 404);
    }
    return record;
  }

  public async startHostedAgent(id: string, institutionId: string): Promise<HostedAgentRecord> {
    await this.assertSettlementReady(institutionId);
    const record = await this.getHostedAgent(id, institutionId);
    const existingState = this.runtimeStates.get(id);
    if (existingState?.child && existingState.child.exitCode === null) {
      throw new PublicError("service_unavailable", 409);
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

  private toHostedRecord(agent: Awaited<ReturnType<AgentManagementService["getAgent"]>>): HostedAgentRecord | null {
    const config = readHostedAgentConfig(agent);
    if (!config) {
      return null;
    }
    return {
      agent,
      config,
      runtime: this.readRuntimeState(agent.id),
    };
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

  private computeHostedSessionTtlMs(config: HostedAgentConfig): number {
    const sessionWindowMs =
      config.tickIntervalMs * config.maxTicks +
      HOSTED_SESSION_BUFFER_SECONDS * 1000;
    return Math.max(sessionWindowMs, HOSTED_SESSION_MINIMUM_SECONDS * 1000);
  }

  private spawnHostedAgent(
    runtime: {
      agentDid: string;
      agentId: string;
      config: HostedAgentConfig;
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
      HOSTED_AGENT_LABEL: runtime.config.label,
      AGENT_SIDE: runtime.config.side,
      AGENT_ASSET_CODE: runtime.config.assetCode,
      AGENT_QUOTE_ASSET_CODE: runtime.config.quoteAssetCode,
      AGENT_OPERATOR_PROMPT: runtime.config.operatorPrompt,
      AGENT_REFERENCE_PRICE: String(runtime.config.referencePrice),
      PRICE_BAND_BPS: String(runtime.config.priceBandBps),
      AGENT_QUANTITY_MIN: String(runtime.config.quantityMin),
      AGENT_QUANTITY_MAX: String(runtime.config.quantityMax),
      TICK_INTERVAL_MS: String(runtime.config.tickIntervalMs),
      MAX_TICKS: String(runtime.config.maxTicks),
      DRY_RUN: runtime.config.dryRun ? "true" : "false",
      ...(runtime.config.groqModel ? { GROQ_MODEL: runtime.config.groqModel } : {}),
    };
    const isWin = process.platform === "win32";
    const shell = isWin && this.runner[0] === "npm";

    const runnerBin = this.runner[0];
    if (!runnerBin) {
      throw new PublicError("service_unavailable", 503, "Runner command is not configured.");
    }
    const runnerArgs = [...this.runner.slice(1)];

    if (isScriptMode && this.hostedScript) {
      return spawn(runnerBin, [...runnerArgs, this.hostedScript], {
        cwd: this.agentsDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell,
      });
    }

    return spawn(runnerBin, [...runnerArgs, "hosted"], {
      cwd: this.agentsDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
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
