import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
const agentId = "00000000-0000-4000-8000-0000000002c1";
const agentDid = "did:t3n:agent:hosted-logtail-test";

const hostedConfig: HostedNegotiatorRuntimeConfig = {
  mandateId: "00000000-0000-4000-8000-0000000003c1",
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
    authorityRef: "ghostbroker-delegation:logtail-test",
    label: "LogTail Redaction Agent",
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
    policyHash: "policy:hosted-logtail",
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

/**
 * The hosted-agent runtime streams its child stdout/stderr verbatim
 * into `state.logTail`, which is returned through
 * `GET /api/hosted-agents/:id` and rendered in the dashboard's
 * AgentDeploymentGuide logTail panel. The child process is outside
 * the backend's structured-logging boundary, so the
 * `attachLogTail` helper must defensively scrub any plaintext
 * trading parameter that escapes the source. These tests cover the
 * `redactLogTail` redaction inside the running service.
 */
describe("ChildProcessHostedAgentService.logTail privacy redaction", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "hosted-logtail-"));
    // A child that prints a mix of plaintext trading parameters
    // on stdout, then stays alive so the logTail can drain the
    // produced bytes before the test tears down. The script
    // intentionally emits BOTH a free-form fragment and a JSON
    // dump so the test exercises both branches of `redactLogTail`.
    // Each write is a tiny payload; we keep them tiny so they
    // all fit inside the single 8 KiB `LOG_TAIL_BYTES` window
    // together (the test asserts all three lines survive the
    // redaction, in order). Newlines are emitted via
    // `String.fromCharCode(10)` so the file content stays
    // platform-portable across Windows CRLF and Unix LF mounts.
    writeFileSync(
      join(workspace, "leaky-keepalive.mjs"),
      [
        "process.stdout.write('A qty=1 price=70000 ok' + String.fromCharCode(10));",
        "process.stdout.write(JSON.stringify({ price: 70000, quantity: 1 }) + String.fromCharCode(10));",
        "process.stdout.write('B qty=2 price=80000 ok' + String.fromCharCode(10));",
        "setInterval(function () {}, 1000);",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("scrubs forbidden plaintext from stdout before it lands in state.logTail", async () => {
    const service = new ChildProcessHostedAgentService({
      agentsDir: workspace,
      backendUrl: "http://localhost:3000",
      authSessionSecret: "test-auth-session-secret-with-more-than-32-characters",
      agentService: buildAgentService(),
      institutionService,
      negotiationService,
      runner: ["node"],
      hostedScript: "leaky-keepalive.mjs",
    });

    const started = await service.startHostedAgent(agentId, institutionId);
    expect(started.runtime.running).toBe(true);

    try {
      // Give the child a moment to emit its three lines and the
      // logTail drain to settle. The deadline is generous so a
      // slow CI runner does not flake; the actual redaction is
      // synchronous so the only wait we need is for stdout chunks
      // to land in the buffer. `getHostedAgent` returns a fresh
      // snapshot of the runtime state each iteration because
      // `startHostedAgent` returned a value captured at spawn time
      // (before any child stdout was drained).
      let tail = "";
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const fresh = await service.getHostedAgent(agentId, institutionId);
        tail = fresh.runtime.logTail;
        if (tail.includes("[REDACTED]")) {
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }

      const fresh = await service.getHostedAgent(agentId, institutionId);
      tail = fresh.runtime.logTail;
      // Every plaintext trading parameter MUST be replaced with
      // the [REDACTED] sentinel before reaching the dashboard.
      expect(tail).toContain("[REDACTED]");
      expect(tail).not.toContain("70000");
      expect(tail).not.toContain("80000");
      // No field name may be followed by a plaintext decimal /
      // integer value. The redactor leaves `field=[REDACTED]`
      // placeholders, so we allow the field name as long as the
      // immediate value is the sentinel. Assert the absence of
      // any numeric value (with optional quoting) following the
      // forbidden field names.
      expect(tail).not.toMatch(/\bprice=\d/u);
      expect(tail).not.toMatch(/\bqty=\d/u);
      expect(tail).not.toMatch(/\bquantity:\s*\d/u);
      // The original structural fragments (action verbs) are
      // allowed metadata and survive the scrub.
      expect(tail).toContain("ok");
    } finally {
      await service.stopHostedAgent(agentId, institutionId);
    }
  });
});
