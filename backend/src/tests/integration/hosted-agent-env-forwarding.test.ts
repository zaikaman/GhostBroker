import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChildProcessHostedAgentService,
} from "../../services/hosted-agent.service.js";
import type { AgentManagementService } from "../../services/agent.service.js";
import type { InstitutionManagementService } from "../../services/institution.service.js";
import type { Agent } from "../../models/agent.js";
import type { HostedNegotiatorRuntimeConfig } from "../../models/hosted-agent.js";
import type { NegotiationManagementService } from "../../services/negotiation.service.js";

const institutionId = "00000000-0000-4000-8000-000000000101";
const agentId = "00000000-0000-4000-8000-0000000002b1";
const agentDid = "did:t3n:agent:hosted-env-test";

const hostedConfig: HostedNegotiatorRuntimeConfig = {
  mandateId: "00000000-0000-4000-8000-0000000003b1",
  pollIntervalMs: 1000,
  maxTicks: 5,
  dryRun: true,
};

function buildAgent(): Agent {
  return {
    id: agentId,
    institutionId,
    agentDid,
    status: "admitted",
    authorityRef: "ghostbroker-delegation:env-test",
    label: "Env Forwarding Agent",
    instrumentScope: null,
    directionScope: null,
    maxNotional: null,
    limitReference: null,
    policyHash: null,
    metadata: { hostedAgent: hostedConfig },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function buildAgentService(): AgentManagementService {
  const agent = buildAgent();
  return {
    admitAgent: async () => { throw new Error("not used"); },
    listAgents: async () => [agent],
    getAgent: async () => agent,
    updateAgentLabel: async () => { throw new Error("not used"); },
    revokeAgent: async () => { throw new Error("not used"); },
    persistDelegation: async () => { throw new Error("not used"); },
    loadDelegationCredential: async () => null,
    configureAgent: async () => { throw new Error("not used"); },
  };
}

const institutionService: Required<Pick<InstitutionManagementService, "getInstitution">> = {
  getInstitution: async () => ({
    id: institutionId,
    legalName: "Northstar Capital Markets LLC",
    displayName: "Northstar Capital",
    status: "active",
    t3TenantDid: "did:t3n:tenant:northstar",
    settlementProfileRef: "settlement-profile:northstar:test",
    metadata: {},
  }),
};

const negotiationService: Pick<NegotiationManagementService, "getMandateByAgent" | "listMandatesByAgent"> = {
  getMandateByAgent: async () => ({
    id: hostedConfig.mandateId,
    institutionId,
    agentId,
    agentDid,
    assetCode: "WBTC",
    side: "buy",
    targetQuantity: "2",
    referencePrice: "100",
    priceBandBps: 50,
    deadline: "2026-01-02T00:00:00.000Z",
    urgency: "normal",
    maxNotional: "200",
    disclosableClaims: [],
    requiredCounterpartyClaims: {},
    counterpartyConstraints: {},
    operatorPrompt: "accumulate quietly",
    policyHash: "policy:hosted-env",
    objective: null,
    executionStyle: null,
    valuationPolicy: null,
    concessionPolicy: null,
    disclosurePolicy: null,
    approvalPolicy: null,
    counterpartyRequirements: null,
    sizePolicy: null,
    timeWindow: null,
    operatorInstructions: null,
    minimumQuantity: null,
    partialExecutionAllowed: null,
    derivedAnchorValue: null,
    derivedWalkawayMin: null,
    derivedWalkawayMax: null,
    derivedConcessionBudgetBps: null,
    derivedNotionalCeiling: null,
    decisionMeta: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  listMandatesByAgent: async () => [],
};

// Env vars we strip-or-inherit. Keep in sync with hosted-agent.service.ts.
const LLM_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "GROQ_API_KEY",
  "GROQ_MODEL",
  "GROQ_BASE_URL",
] as const;

describe("ChildProcessHostedAgentService env forwarding", () => {
  let workspace: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "hosted-env-"));
    // A short-lived child that snapshots the LLM env vars it actually
    // received into a JSON file at a fixed relative path, then exits
    // cleanly. The service always spawns the child with cwd =
    // agentsDir, so the snapshot lands inside the tmp workspace and
    // is cleaned up by afterEach.
    writeFileSync(
      join(workspace, "env-dumper.mjs"),
      [
        "import { writeFileSync } from 'node:fs';",
        "const snapshot = {",
        ...LLM_ENV_KEYS.map((key) => `  ${key}: process.env.${key} ?? null,`),
        "};",
        "writeFileSync('env-snapshot.json', JSON.stringify(snapshot));",
        "",
      ].join("\n"),
    );

    // Snapshot the parent env so the test can mutate it without
    // leaking into other tests in the suite.
    savedEnv = {};
    for (const key of LLM_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("inherits LLM env from the parent when no local .env exists (Heroku-style)", async () => {
    // Simulate Heroku config vars by setting the LLM env on the
    // parent process before the service spawns the child.
    process.env.GEMINI_API_KEY = "parent-gemini-key";
    process.env.GEMINI_MODEL = "parent-gemini-model";
    process.env.GEMINI_BASE_URL = "https://parent-gemini.example/v1beta";
    process.env.OPENAI_API_KEY = "parent-openai-key";
    process.env.GROQ_API_KEY = "parent-groq-key";

    const service = new ChildProcessHostedAgentService({
      agentsDir: workspace,
      backendUrl: "http://localhost:3000",
      authSessionSecret: "test-auth-session-secret-with-more-than-32-characters",
      agentService: buildAgentService(),
      institutionService,
      negotiationService,
      runner: ["node"],
      hostedScript: "env-dumper.mjs",
    });

    const started = await service.startHostedAgent(agentId, institutionId);
    expect(started.runtime.running).toBe(true);

    const outFile = join(workspace, "env-snapshot.json");
    const pid = started.runtime.pid;
    expect(pid).toBeTypeOf("number");
    if (pid === undefined) throw new Error("expected spawned child to have a pid");
    await waitForExit(pid);

    const snapshot = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, string | null>;
    expect(snapshot.GEMINI_API_KEY).toBe("parent-gemini-key");
    expect(snapshot.GEMINI_MODEL).toBe("parent-gemini-model");
    expect(snapshot.GEMINI_BASE_URL).toBe("https://parent-gemini.example/v1beta");
    expect(snapshot.OPENAI_API_KEY).toBe("parent-openai-key");
    expect(snapshot.GROQ_API_KEY).toBe("parent-groq-key");

    // Running stopHostedAgent cleans up the runtime state even though
    // the dumper has already exited on its own.
    const stopped = await service.stopHostedAgent(agentId, institutionId);
    expect(stopped.runtime.running).toBe(false);
  });

  it("strips LLM env from the parent when a local .env exists (local-dev safety)", async () => {
    // Parent has (possibly stale) LLM env. The presence of a local
    // .env means it is the canonical source — loadDotEnv will re-fill
    // the child's LLM env from this file. We just verify the child
    // does NOT see the parent's stale values.
    process.env.GEMINI_API_KEY = "stale-parent-gemini-key";
    process.env.GEMINI_BASE_URL = "https://stale-proxy.example/v1beta";
    process.env.OPENAI_API_KEY = "stale-parent-openai-key";

    writeFileSync(
      join(workspace, ".env"),
      [
        "GEMINI_API_KEY=canonical-local-gemini-key",
        "GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta",
        "GROQ_API_KEY=canonical-local-groq-key",
        "",
      ].join("\n"),
    );

    const service = new ChildProcessHostedAgentService({
      agentsDir: workspace,
      backendUrl: "http://localhost:3000",
      authSessionSecret: "test-auth-session-secret-with-more-than-32-characters",
      agentService: buildAgentService(),
      institutionService,
      negotiationService,
      runner: ["node"],
      hostedScript: "env-dumper.mjs",
    });

    const started = await service.startHostedAgent(agentId, institutionId);
    expect(started.runtime.running).toBe(true);

    const outFile = join(workspace, "env-snapshot.json");
    const pid = started.runtime.pid;
    expect(pid).toBeTypeOf("number");
    if (pid === undefined) throw new Error("expected spawned child to have a pid");
    await waitForExit(pid);

    const snapshot = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, string | null>;
    // Parent's stale LLM env MUST NOT survive into the child — the
    // canonical local .env is the source of truth, and loadDotEnv
    // will re-fill GEMINI_API_KEY / GROQ_API_KEY from it after the
    // spawn strips the parent values.
    expect(snapshot.GEMINI_API_KEY).toBeNull();
    expect(snapshot.OPENAI_API_KEY).toBeNull();
    expect(snapshot.GEMINI_BASE_URL).toBeNull();
    expect(snapshot.OPENAI_BASE_URL).toBeNull();
    // GROQ_API_KEY was not set in the parent, so the child's view of
    // it is also null at the point the env-dumper runs (loadDotEnv
    // happens inside hosted-agent.ts; this test only exercises the
    // service's spawn-time stripping, not loadDotEnv itself).
    expect(snapshot.GROQ_API_KEY).toBeNull();

    await service.stopHostedAgent(agentId, institutionId);
  });
});

function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      try {
        // signal 0 = existence check; throws ESRCH if dead.
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          resolve();
          return;
        }
        reject(err as Error);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`child pid ${pid} did not exit within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}
