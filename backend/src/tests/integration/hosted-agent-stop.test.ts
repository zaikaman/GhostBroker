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
    policyHash: "policy:hosted-stop",
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
    rmSync(workspace, { recursive: true, force: true });
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
});
