import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { PublicError } from "../errors/public-error.js";
import {
  type CreateHostedAgentRequest,
  type HostedAgentConfig,
  type HostedAgentRecord,
  type HostedAgentRuntimeStatus,
  readHostedAgentConfig,
} from "../models/hosted-agent.js";
import type { AgentManagementService } from "./agent.service.js";
import type { ApiKeyManagementService } from "./api-key.service.js";
import type { TenantDelegationSigner } from "./tenant-delegation-signer.js";

const LOG_TAIL_BYTES = 8192;

interface HostedAgentRuntimeState {
  agentId: string;
  institutionId: string;
  child: ChildProcess | undefined;
  startedAt: string | undefined;
  stoppedAt: string | undefined;
  lastExitCode: number | undefined;
  lastSignal: string | undefined;
  apiKeyId: string | undefined;
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
  apiKeyService: ApiKeyManagementService;
  agentService: AgentManagementService;
  tenantSigner: TenantDelegationSigner;
  runner?: readonly string[];
  hostedScript?: string;
}

export class ChildProcessHostedAgentService implements HostedAgentManagementService {
  private readonly runtimeStates = new Map<string, HostedAgentRuntimeState>();
  private readonly agentsDir: string;
  private readonly backendUrl: string;
  private readonly apiKeyService: ApiKeyManagementService;
  private readonly agentService: AgentManagementService;
  private readonly tenantSigner: TenantDelegationSigner;
  private readonly runner: readonly string[];
  private readonly hostedScript: string | undefined;

  public constructor(options: ChildProcessHostedAgentServiceOptions) {
    this.agentsDir = resolve(options.agentsDir);
    this.backendUrl = options.backendUrl;
    this.apiKeyService = options.apiKeyService;
    this.agentService = options.agentService;
    this.tenantSigner = options.tenantSigner;
    this.runner = options.runner ?? ["npm", "run"];
    this.hostedScript = options.hostedScript;
  }

  public async createHostedAgent(input: CreateHostedAgentRequest): Promise<HostedAgentRecord> {
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

    const updated = await this.agentService.updateAgentMetadata!({
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
    const record = await this.getHostedAgent(id, institutionId);
    const existingState = this.runtimeStates.get(id);
    if (existingState?.child && existingState.child.exitCode === null) {
      throw new PublicError("service_unavailable", 409);
    }

    const apiKey = await this.apiKeyService.createKey(
      institutionId,
      `hosted-${record.config.label.toLowerCase().replace(/\s+/gu, "-")}`,
      ["agent:operate"],
    );

    const child = this.spawnHostedAgent(record.agent.agentDid, apiKey.key, record.config, id);
    const state: HostedAgentRuntimeState = {
      agentId: id,
      institutionId,
      child,
      startedAt: new Date().toISOString(),
      stoppedAt: undefined,
      lastExitCode: undefined,
      lastSignal: undefined,
      apiKeyId: apiKey.id,
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

    if (state.child && state.child.exitCode === null) {
      state.child.kill("SIGTERM");
      await new Promise((resolveStop) => setTimeout(resolveStop, 1000));
      if (state.child.exitCode === null) {
        state.child.kill("SIGKILL");
      }
    }

    if (state.apiKeyId) {
      try {
        await this.apiKeyService.revokeKey(state.apiKeyId, institutionId);
      } catch {
        // best effort
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
        apiKeyId: undefined,
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
      apiKeyId: state.apiKeyId,
      lastError: state.lastError,
      logTail: state.logTail,
    };
  }

  private spawnHostedAgent(
    agentDid: string,
    apiKey: string,
    config: HostedAgentConfig,
    agentId: string,
  ): ChildProcess {
    const isScriptMode = this.hostedScript !== undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GHOSTBROKER_URL: this.backendUrl,
      GHOSTBROKER_API_KEY: apiKey,
      AGENT_IDENTITY_DID: agentDid,
      HOSTED_AGENT_ID: agentId,
      HOSTED_AGENT_LABEL: config.label,
      AGENT_SIDE: config.side,
      AGENT_ASSET_CODE: config.assetCode,
      AGENT_QUOTE_ASSET_CODE: config.quoteAssetCode,
      AGENT_OPERATOR_PROMPT: config.operatorPrompt,
      AGENT_REFERENCE_PRICE: String(config.referencePrice),
      PRICE_BAND_BPS: String(config.priceBandBps),
      AGENT_QUANTITY_MIN: String(config.quantityMin),
      AGENT_QUANTITY_MAX: String(config.quantityMax),
      TICK_INTERVAL_MS: String(config.tickIntervalMs),
      MAX_TICKS: String(config.maxTicks),
      DRY_RUN: config.dryRun ? "true" : "false",
      ...(config.groqModel ? { GROQ_MODEL: config.groqModel } : {}),
    };
    const isWin = process.platform === "win32";
    const shell = isWin && this.runner[0] === "npm";

    if (isScriptMode && this.hostedScript) {
      return spawn(this.runner[0]!, [...this.runner.slice(1), this.hostedScript], {
        cwd: this.agentsDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell,
      });
    }

    return spawn(this.runner[0]!, [...this.runner.slice(1), "hosted"], {
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

