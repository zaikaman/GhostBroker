/**
 * Set up a fresh buyer + seller pair on the local GhostBroker backend
 * and trigger their hosted negotiators. The script:
 *
 *   1. Authenticates against the two E2E test institutions via API key.
 *   2. Configures a fresh agent under each institution (new DID, fresh
 *      delegation VC signed server-side by the tenant signer).
 *   3. Creates a fresh negotiation mandate on each agent with a
 *      compatible, *convergence-friendly* policy:
 *        - executionStyle: "balanced"   (no narrow trust-first band)
 *        - requiredClaims: []           (no disclosure gate deadlock)
 *        - disclosableClaims: []
 *        - approvalPolicy: auto_settle  (no escalation stalls)
 *        - targetQuantity: 0.0001 WBTC  (sub-unit fill; requires the
 *                                    matching contract's fractional
 *                                    wire form, v0.4.0+)
 *        - referencePrice: 70000        (matches the .env)
 *   4. Attaches a hosted-agent config to each agent and starts them.
 *   5. Polls the negotiation sessions until they reach `settled` (or
 *      90s timeout).
 *
 * Run with:  npx tsx scripts/setup-trade-pair.ts
 */
import { createHash, randomUUID } from "node:crypto";

const BACKEND = process.env.GHOSTBROKER_URL ?? "http://localhost:3001";
const BUYER_INST = "00000000-0000-4000-8000-0000000007a1";
const SELLER_INST = "00000000-0000-4000-8000-0000000007a2";
const BUYER_KEY = "gbk_DnOR8QnB_DnOR8QnBra5M5dUjnG_j2vxDyH6ILQspjIfnYwhD0GU";
const SELLER_KEY = "gbk_RfylFnE0_RfylFnE0bVwn0bKgcapeeu8zmq02XGMmM5gFc1j15js";

const REF_PRICE = 70_000;
const TARGET_QTY = 0.0001;
const NOTIONAL = (REF_PRICE * TARGET_QTY).toFixed(2);
const DEADLINE = new Date(Date.now() + 30 * 60 * 1000).toISOString();

function makeAgentDid(label: string): string {
  const rand = createHash("sha256")
    .update(`${label}-${randomUUID()}`)
    .digest("hex")
    .slice(0, 40);
  return `did:t3n:demo-${label}-${rand}`;
}

interface AuthSession {
  token: string;
  expiresAt: string;
  institution: { id: string; displayName: string; t3TenantDid: string };
}

async function authenticate(apiKey: string): Promise<AuthSession> {
  const response = await fetch(`${BACKEND}/api/auth/api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`auth failed (${response.status}): ${text}`);
  }
  return (await response.json()) as AuthSession;
}

async function callApi(
  path: string,
  token: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep as text
  }
  return { status: response.status, body };
}

interface ProvisionedAgent {
  agentId: string;
  agentDid: string;
  authorityRef: string;
  policyHash: string;
}

async function configureAgent(
  token: string,
  institutionId: string,
  label: string,
  agentDid: string,
): Promise<ProvisionedAgent> {
  const { status, body } = await callApi(
    "/api/agents/configure",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        institutionId,
        agentDid,
        label,
        policy: {
          maxSpendUsd: 1_000_000,
          allowedCategories: ["services"],
          purpose: `E2E trade pair smoke test (${label})`,
        },
      }),
    },
  );
  if (status !== 201) {
    throw new Error(
      `configureAgent ${label} failed: ${status} ${JSON.stringify(body)}`,
    );
  }
  const result = body as {
    agent: { id: string; agentDid: string };
    admission: { authorityRef: string };
    policyHash: string;
  };
  return {
    agentId: result.agent.id,
    agentDid: result.agent.agentDid,
    authorityRef: result.admission.authorityRef,
    policyHash: result.policyHash,
  };
}

interface CreatedMandate {
  mandateId: string;
  policyHash: string;
}

async function createMandate(
  token: string,
  institutionId: string,
  agentId: string,
  side: "buy" | "sell",
): Promise<CreatedMandate> {
  const mandate = {
    assetCode: "WBTC",
    side,
    targetQuantity: TARGET_QTY,
    referencePrice: REF_PRICE,
    priceBandBps: 100,
    deadline: DEADLINE,
    urgency: "normal",
    maxNotional: NOTIONAL,
    disclosableClaims: [],
    requiredCounterpartyClaims: {},
    counterpartyConstraints: {},
    operatorPrompt:
      side === "buy"
        ? `Buy ${TARGET_QTY} WBTC at the anchor ($${REF_PRICE}). No disclosure requirements. Auto-settle on first cross.`
        : `Sell ${TARGET_QTY} WBTC at the anchor ($${REF_PRICE}). No disclosure requirements. Auto-settle on first cross.`,
  };
  const { status, body } = await callApi(
    `/api/agents/${agentId}/mandate`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ mandate }),
    },
  );
  if (status !== 200) {
    throw new Error(
      `createMandate ${side} failed: ${status} ${JSON.stringify(body)}`,
    );
  }
  const result = body as {
    mandate: { id: string };
    policyHash: string;
  };
  return { mandateId: result.mandate.id, policyHash: result.policyHash };
}

interface HostedAgent {
  id: string;
  config: { mandateId: string } | null;
  runtime: { running: boolean; pid?: number; lastError?: string };
}

async function createHostedConfig(
  token: string,
  institutionId: string,
  agentId: string,
  mandateId: string,
): Promise<void> {
  const { status, body } = await callApi(
    "/api/hosted-agents",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        institutionId,
        agentId,
        startOnCreate: false,
        config: {
          mandateId,
          pollIntervalMs: 5000,
          maxTicks: 30,
          dryRun: false,
        },
      }),
    },
  );
  if (status !== 201) {
    throw new Error(
      `createHostedConfig failed: ${status} ${JSON.stringify(body)}`,
    );
  }
  void body as unknown as HostedAgent;
}

async function startHostedAgent(
  token: string,
  agentId: string,
): Promise<HostedAgent> {
  const { status, body } = await callApi(
    `/api/hosted-agents/${agentId}/start`,
    token,
    { method: "POST", body: JSON.stringify({}) },
  );
  if (status !== 200) {
    throw new Error(
      `startHostedAgent failed: ${status} ${JSON.stringify(body)}`,
    );
  }
  return body as HostedAgent;
}

interface SessionSummary {
  id: string;
  status: string;
  currentTurn: string;
  roundNumber: number;
  deadline: string;
  tradeRef: string | null;
  buyInstitutionId: string;
  sellInstitutionId: string;
  trustLevel: string;
  disclosureProgress: { receivedVerifiedClaims: string[]; pendingRequiredClaims: string[] };
}

async function _listSessions(token: string): Promise<SessionSummary[]> {
  const { status, body } = await callApi("/api/negotiations", token, {
    method: "GET",
  });
  if (status !== 200) {
    throw new Error(`listSessions failed: ${status} ${JSON.stringify(body)}`);
  }
  const data = body as { sessions: SessionSummary[] };
  return data.sessions;
}

async function main(): Promise<void> {
  console.log(`[setup] target backend: ${BACKEND}`);

  const buyerSession = await authenticate(BUYER_KEY);
  const sellerSession = await authenticate(SELLER_KEY);
  console.log(
    `[setup] buyer token expires ${buyerSession.expiresAt}, seller token expires ${sellerSession.expiresAt}`,
  );

  // Provision a fresh agent under each institution.
  const buyerAgentDid = makeAgentDid("buyer");
  const sellerAgentDid = makeAgentDid("seller");
  console.log(`[setup] provisioning agents...`);
  const buyerAgent = await configureAgent(
    buyerSession.token,
    BUYER_INST,
    "E2E Buyer (v2)",
    buyerAgentDid,
  );
  console.log(`[setup] buyer agent: ${buyerAgent.agentId} (${buyerAgent.agentDid})`);
  const sellerAgent = await configureAgent(
    sellerSession.token,
    SELLER_INST,
    "E2E Seller (v2)",
    sellerAgentDid,
  );
  console.log(`[setup] seller agent: ${sellerAgent.agentId} (${sellerAgent.agentDid})`);

  // Create the matching negotiation mandates.
  console.log(`[setup] creating mandates...`);
  const buyerMandate = await createMandate(
    buyerSession.token,
    BUYER_INST,
    buyerAgent.agentId,
    "buy",
  );
  console.log(`[setup] buyer mandate: ${buyerMandate.mandateId}`);
  const sellerMandate = await createMandate(
    sellerSession.token,
    SELLER_INST,
    sellerAgent.agentId,
    "sell",
  );
  console.log(`[setup] seller mandate: ${sellerMandate.mandateId}`);

  // Attach the hosted-agent configs.
  console.log(`[setup] attaching hosted-agent configs...`);
  await createHostedConfig(
    buyerSession.token,
    BUYER_INST,
    buyerAgent.agentId,
    buyerMandate.mandateId,
  );
  await createHostedConfig(
    sellerSession.token,
    SELLER_INST,
    sellerAgent.agentId,
    sellerMandate.mandateId,
  );

  // Start the hosted agents (the backend spawns the child processes).
  console.log(`[setup] starting hosted agents...`);
  const buyerHosted = await startHostedAgent(
    buyerSession.token,
    buyerAgent.agentId,
  );
  console.log(
    `[setup] buyer hosted: running=${buyerHosted.runtime.running} pid=${buyerHosted.runtime.pid}`,
  );
  const sellerHosted = await startHostedAgent(
    sellerSession.token,
    sellerAgent.agentId,
  );
  console.log(
    `[setup] seller hosted: running=${sellerHosted.runtime.running} pid=${sellerHosted.runtime.pid}`,
  );

  // Save the agent + mandate IDs for the watcher script.
  const out = {
    buyer: {
      institutionId: BUYER_INST,
      agentId: buyerAgent.agentId,
      agentDid: buyerAgent.agentDid,
      mandateId: buyerMandate.mandateId,
      authorityRef: buyerAgent.authorityRef,
      policyHash: buyerAgent.policyHash,
      sessionToken: buyerSession.token,
    },
    seller: {
      institutionId: SELLER_INST,
      agentId: sellerAgent.agentId,
      agentDid: sellerAgent.agentDid,
      mandateId: sellerMandate.mandateId,
      authorityRef: sellerAgent.authorityRef,
      policyHash: sellerAgent.policyHash,
      sessionToken: sellerSession.token,
    },
    deadline: DEADLINE,
    referencePrice: REF_PRICE,
  };
  console.log("\n[setup] === SETUP COMPLETE ===");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err: unknown) => {
  console.error("[setup] fatal:", err);
  process.exit(1);
});
