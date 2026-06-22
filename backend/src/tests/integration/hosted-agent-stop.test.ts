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
const agentId = "00000000-0000-4000-8000-0000000002a1";
const agentDid = "did:t3n:agent:hosted-stop-test";

const hostedConfig: HostedNegotiatorRuntimeConfig = {
  mandateId: "00000000-0000-4000-8000-0000000003a1",
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
    authorityRef: "ghostbroker-delegation:stop-test",
    label: "Stop Race Agent",
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

const negotiationService: Pick<NegotiationManagementService, "getMandateByAgent" | "listMandatesByAgent"> = {    getMandateByAgent: async () => ({
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
    policyHash: "policy:hosted-stop",
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

describe("ChildProcessHostedAgentService.stopHostedAgent", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "hosted-stop-"));
    // A long-lived child that exits cleanly on SIGTERM. Killing it
    // makes the `exit` handler null out `state.child` during the
    // stop method''s 1s wait window — the exact race that produced
    // the 500 on POST /hosted-agents/:id/stop.
    writeFileSync(
      join(workspace, "keepalive.mjs"),
      "setInterval(() => {}, 1000);\n",
    );
  });

  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // Windows may hold file locks on temp directories long enough
      // that an immediate rmSync fails with EPERM. The directory
      // will be cleaned up by the OS eventually; there's nothing
      // the test can do to force it.
    }
  });

  it("stops a running hosted agent without throwing when the child exits mid-stop", async () => {
    const service = new ChildProcessHostedAgentService({
      agentsDir: workspace,
      backendUrl: "http://localhost:3000",
      authSessionSecret: "test-auth-session-secret-with-more-than-32-characters",
      agentService: buildAgentService(),
      institutionService,
      negotiationService,
      runner: ["node"],
      hostedScript: "keepalive.mjs",
      tenantIdentityLookup: async () => ({
        signingPrivateKey: "0x" + "11".repeat(32),
        signingPublicKey: "0x02" + "22".repeat(32),
        issuerDid: "did:ethr:0x" + "33".repeat(20),
      }),
    });

    const started = await service.startHostedAgent(agentId, institutionId);
    expect(started.runtime.running).toBe(true);

    const stopped = await service.stopHostedAgent(agentId, institutionId);
    expect(stopped.runtime.running).toBe(false);

    // A second stop on an already-stopped agent must also be a no-op,
    // never a 500.
    const stoppedAgain = await service.stopHostedAgent(agentId, institutionId);
    expect(stoppedAgain.runtime.running).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "terminates the grandchild process tree on Windows shell-mode spawn",
    async () => {
      // Reproduces the dashboard's STOP button being a no-op on
      // Windows. The production spawn uses `runner: ["npm", "run"]`
      // with `shell: true`, so `child` is the cmd.exe wrapper and
      // the actual `node hosted-agent.ts` is a grandchild. Plain
      // `child.kill()` only kills the wrapper; the grandchild keeps
      // polling. After the fix, taskkill /T /F walks the tree.
      const pidFile = join(workspace, "grandchild.pid");
      writeFileSync(
        join(workspace, "keepalive-grandchild.mjs"),
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(pidFile.replace(/\\/g, "\\\\"))}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
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
        // cmd.exe /c is the closest in-test analogue to `npm run`
        // on Windows: the spawned `child` is the shell wrapper, and
        // the long-lived grandchild is `node keepalive-grandchild.mjs`.
        runner: ["cmd.exe", "/c"],
        hostedScript: "node keepalive-grandchild.mjs",
        tenantIdentityLookup: async () => ({
          signingPrivateKey: "0x" + "11".repeat(32),
          signingPublicKey: "0x02" + "22".repeat(32),
          issuerDid: "did:ethr:0x" + "33".repeat(20),
        }),
      });

      const started = await service.startHostedAgent(agentId, institutionId);
      expect(started.runtime.running).toBe(true);
      expect(started.runtime.pid).toBeTypeOf("number");

      // Wait for the grandchild to record its pid so we can prove
      // taskkill /T reaches it (not just the cmd.exe wrapper).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const recorded = readFileSync(pidFile, "utf8").trim();
          if (recorded) break;
        } catch {
          // file not written yet
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      expect(Number.isFinite(grandchildPid)).toBe(true);
      // Sanity-check the test setup: wrapper pid must differ from
      // grandchild pid. If they're ever equal the test is no longer
      // exercising the shell-wrapped path.
      expect(grandchildPid).not.toBe(started.runtime.pid);

      const stopped = await service.stopHostedAgent(agentId, institutionId);
      expect(stopped.runtime.running).toBe(false);

      // Give the OS a moment to reap after TerminateProcess.
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));

      // process.kill(pid, 0) on Windows throws ESRCH if the pid is
      // gone. The whole point of the fix is that this no longer
      // throws — the grandchild was actually killed, not just the
      // cmd.exe wrapper.
      let grandchildAlive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch (err) {
        grandchildAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
      expect(grandchildAlive).toBe(false);
    },
  );
});
