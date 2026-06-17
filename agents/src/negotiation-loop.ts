import {
  GhostBrokerApiError,
  GhostBrokerClient,
  type AgentAdmission,
  type AuthSession,
  type RedactedNegotiationSessionView,
} from "@ghostbroker/agent-client";
import type { AgentEnv } from "./env.js";
import {
  type NegotiationContext,
  type NegotiationDecision,
  type NegotiationLlmClient,
} from "./negotiation-decision.js";
import { loadOrGenerateIdentity } from "./identity.js";

/**
 * The expanded runtime mandate as returned by the hosted-mandate
 * endpoint. Mirrors the backend's authored + derived rails so the
 * agent loop has everything it needs to build a rich context.
 */
interface RuntimeMandate {
  id: string;
  assetCode: string;
  side: "buy" | "sell";
  targetQuantity: number;
  minimumQuantity: number;
  partialExecutionAllowed: boolean;
  referencePrice: number;
  priceBandBps: number;
  maxNotional: number;
  urgency: "low" | "normal" | "high" | "critical";
  deadline: string;
  disclosableClaims: string[];
  requiredCounterpartyClaims: string[];
  counterpartyConstraints: Record<string, unknown>;
  operatorPrompt: string;
  policyHash: string;

  // --- Authored policy fields ---
  objective: string | null;
  executionStyle:
    | "patient"
    | "balanced"
    | "aggressive"
    | "relationship_first"
    | "trust_first"
    | null;
  valuationPolicy: Record<string, unknown> | null;
  concessionPolicy: Record<string, unknown> | null;
  disclosurePolicy: Record<string, unknown> | null;
  approvalPolicy: Record<string, unknown> | null;
  counterpartyRequirements: Record<string, unknown> | null;
  sizePolicy: Record<string, unknown> | null;
  timeWindow: Record<string, unknown> | null;
  operatorInstructions: string | null;
  derivedAnchorValue: number | null;
  derivedWalkawayMin: number | null;
  derivedWalkawayMax: number | null;
  derivedConcessionBudgetBps: number | null;
  derivedNotionalCeiling: number | null;
}

export interface NegotiationLoopOptions {
  env: AgentEnv;
  llm: NegotiationLlmClient;
}

export interface NegotiationLoopResult {
  outcome:
    | "settled"
    | "walked_away"
    | "expired"
    | "max_ticks_reached"
    | "admit_failed";
  ticksRun: number;
  sessionId: string | undefined;
  lastDecision: NegotiationDecision | undefined;
  settlementCorrelationRef: string | undefined;
  admissionAuthorityRef: string | undefined;
}

function buildSessionFromEnv(env: AgentEnv): AuthSession | undefined {
  if (
    !env.GHOSTBROKER_SESSION_TOKEN ||
    !env.GHOSTBROKER_INSTITUTION_ID ||
    !env.GHOSTBROKER_INSTITUTION_DISPLAY_NAME ||
    !env.GHOSTBROKER_INSTITUTION_TENANT_DID
  ) {
    return undefined;
  }

  return {
    token: env.GHOSTBROKER_SESSION_TOKEN,
    expiresAt:
      env.GHOSTBROKER_SESSION_EXPIRES_AT ??
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    institution: {
      id: env.GHOSTBROKER_INSTITUTION_ID,
      displayName: env.GHOSTBROKER_INSTITUTION_DISPLAY_NAME,
      t3TenantDid: env.GHOSTBROKER_INSTITUTION_TENANT_DID,
    },
  };
}

async function fetchHostedMandate(
  env: AgentEnv,
  mandateId: string,
): Promise<RuntimeMandate> {
  const mandateUrl = new URL(
    `/api/agents/${env.HOSTED_AGENT_ID}/mandate`,
    env.GHOSTBROKER_URL,
  );
  mandateUrl.searchParams.set("mandateId", mandateId);

  const response = await fetch(mandateUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${env.GHOSTBROKER_SESSION_TOKEN}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Hosted mandate lookup failed (${response.status}): ${body || response.statusText}`,
    );
  }

  const mandate = (await response.json()) as RuntimeMandate;
  if (mandate.id !== mandateId) {
    throw new Error(
      `Hosted mandate mismatch: expected ${mandateId}, got ${mandate.id}`,
    );
  }
  return mandate;
}

export async function runNegotiationLoop(
  options: NegotiationLoopOptions,
): Promise<NegotiationLoopResult> {
  const { env, llm } = options;
  const identity = loadOrGenerateIdentity(env.AGENT_IDENTITY_CONFIG_PATH);

  const seededSession = buildSessionFromEnv(env);
  const client = new GhostBrokerClient({
    baseUrl: env.GHOSTBROKER_URL,
    ...(seededSession
      ? {
          token: seededSession.token,
          institutionId: seededSession.institution.id,
        }
      : {}),
  });

  let session: AuthSession;
  try {
    if (seededSession) {
      session = seededSession;
    } else if (env.GHOSTBROKER_API_KEY) {
      session = await client.authenticateWithApiKey(env.GHOSTBROKER_API_KEY);
    } else {
      throw new Error("Missing GhostBroker session token and API key.");
    }
  } catch (err) {
    console.error(`Authentication failed: ${formatError(err)}`);
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      sessionId: undefined,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
    };
  }

  if (!env.HOSTED_MANDATE_ID) {
    console.error("Missing hosted mandate id.");
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      sessionId: undefined,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
    };
  }

  let mandate: RuntimeMandate;
  try {
    mandate = await fetchHostedMandate(env, env.HOSTED_MANDATE_ID);
  } catch (err) {
    console.error(`Mandate fetch failed: ${formatError(err)}`);
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      sessionId: undefined,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
    };
  }

  const side = mandate.side;
  const assetCode = mandate.assetCode;
  const quoteAssetCode = env.AGENT_QUOTE_ASSET_CODE;
  log(side, `Hosted negotiator booting with DID ${identity.did}`);
  log(
    side,
    `Mandate: ${mandate.objective ?? "(legacy)"} style=${mandate.executionStyle ?? "(legacy)"} urgency=${mandate.urgency}`,
  );

  let admission: AgentAdmission;
  try {
    admission = await client.admitAgent({
      institutionId: session.institution.id,
      agentDid: identity.did,
    });
  } catch (err) {
    log(side, `Admit failed: ${formatError(err)}`);
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      sessionId: undefined,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
    };
  }

  client.telemetry.connect();
  let settlementCorrelationRef: string | undefined;
  const stopOnSettle = client.telemetry.onSettled((ref) => {
    settlementCorrelationRef = ref;
    log(side, `Negotiation settled: ${ref}`);
  });

  let sessionId: string | undefined;
  try {
    const ticket = await client.submitNegotiationTicket({
      agentId: env.HOSTED_AGENT_ID ?? "00000000-0000-0000-0000-000000000000",
      agentDid: identity.did,
      policyHash: admission.authorityRef,
      assetCode,
      side,
      compatibilityToken: `${assetCode}:${side}:${session.institution.id}`,
    });
    sessionId = ticket.sessionId ?? undefined;
    log(side, `Negotiation ticket sealed: ${ticket.ticketHandle}`);
  } catch (err) {
    stopOnSettle();
    client.telemetry.disconnect();
    throw err;
  }

  let lastDecision: NegotiationDecision | undefined;
  let lastOutcome = "(start of negotiation)";
  let priorMoveRationale: string | undefined;

  for (let tick = 1; tick <= env.MAX_TICKS; tick += 1) {
    log(side, `Negotiation tick ${tick}/${env.MAX_TICKS}`);

    if (settlementCorrelationRef !== undefined) {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "settled",
        ticksRun: tick,
        sessionId,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }

    const listed = await client.listNegotiationSessions();
    const liveSession = sessionId
      ? listed.sessions.find((item) => item.id === sessionId)
      : listed.sessions[0];
    if (!liveSession) {
      lastOutcome = "awaiting counterparty pairing";
      await sleep(env.POLL_INTERVAL_MS);
      continue;
    }
    sessionId = liveSession.id;

    if (liveSession.status === "walked_away") {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "walked_away",
        ticksRun: tick,
        sessionId,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }
    if (liveSession.status === "expired") {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "expired",
        ticksRun: tick,
        sessionId,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }
    if (liveSession.status === "settled") {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "settled",
        ticksRun: tick,
        sessionId,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }

    if (liveSession.currentTurn !== side) {
      lastOutcome = `waiting for ${liveSession.currentTurn} turn`;
      await sleep(env.POLL_INTERVAL_MS);
      continue;
    }

    const ctx = buildNegotiationContext({
      mandate,
      quoteAssetCode,
      session: liveSession,
      lastOutcome,
      priorMoveRationale,
    });

    let decision: NegotiationDecision;
    try {
      decision = await llm.decide(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(side, `Negotiation LLM call failed: ${message}`);
      lastOutcome = `llm failed: ${message.slice(0, 80)}`;
      await sleep(env.POLL_INTERVAL_MS);
      continue;
    }

    lastDecision = decision;
    priorMoveRationale = decision.reasoning;
    log(
      side,
      `[${decision.strategicIntent ?? "?"}] ${decision.action} qty=${decision.quantity ?? 0} price=${decision.price ?? 0} conf=${decision.confidence?.toFixed(2) ?? "?"} escalate=${decision.escalationRequested} ready=${decision.settlementReadiness ?? "?"} (${decision.reasoning.slice(0, 120)})`,
    );

    try {
      if (decision.action === "walkaway") {
        const result = await client.walkAwayNegotiation(sessionId, {
          agentId: env.HOSTED_AGENT_ID ?? "00000000-0000-0000-0000-000000000000",
          agentDid: identity.did,
          authorityRef: admission.authorityRef,
          reasoning: decision.reasoning,
        });
        lastOutcome = `walkaway -> ${result.status}`;
      } else {
        const result = await client.submitNegotiationMove(sessionId, {
          agentId: env.HOSTED_AGENT_ID ?? "00000000-0000-0000-0000-000000000000",
          agentDid: identity.did,
          authorityRef: admission.authorityRef,
          move: decision,
        });
        lastOutcome = `move -> ${result.status}`;
      }
    } catch (err) {
      if (err instanceof GhostBrokerApiError) {
        if (err.status === 409 || err.status === 403) {
          lastOutcome = `move rejected ${err.status}`;
          await sleep(env.POLL_INTERVAL_MS);
          continue;
        }
        if (err.isRetryable || err.status === 429) {
          lastOutcome = `retryable move error ${err.status}`;
          await sleep(env.POLL_INTERVAL_MS);
          continue;
        }
      }
      throw err;
    }

    await sleep(env.POLL_INTERVAL_MS);
  }

  stopOnSettle();
  client.telemetry.disconnect();
  return {
    outcome: "max_ticks_reached",
    ticksRun: env.MAX_TICKS,
    sessionId,
    lastDecision,
    settlementCorrelationRef,
    admissionAuthorityRef: admission.authorityRef,
  };
}

/**
 * Build the full NegotiationContext from the runtime mandate + live
 * session view. Uses authored policy fields when available, falls
 * back to legacy derived fields for compatibility.
 */
function buildNegotiationContext(input: {
  mandate: RuntimeMandate;
  quoteAssetCode: string;
  session: RedactedNegotiationSessionView;
  lastOutcome: string;
  priorMoveRationale?: string;
}): NegotiationContext {
  const { mandate, quoteAssetCode, session, lastOutcome, priorMoveRationale } =
    input;

  // Resolve authored vs legacy fields.
  const objective = mandate.objective ?? mandate.operatorPrompt;
  const executionStyle = mandate.executionStyle ?? "balanced";
  const approvalPolicy = (mandate.approvalPolicy ??
    {}) as Record<string, unknown>;
  const approvalMode =
    (approvalPolicy.mode as "auto_settle" | "escalate_outside_envelope") ??
    "auto_settle";
  const concessionPolicy = (mandate.concessionPolicy ??
    {}) as Record<string, unknown>;
  const concessionBudgetBps =
    mandate.derivedConcessionBudgetBps ??
    (concessionPolicy.maxConcessionBps as number | undefined) ??
    mandate.priceBandBps;

  const sizePolicy = (mandate.sizePolicy ?? {}) as Record<string, unknown>;
  const minimumQuantity =
    mandate.minimumQuantity ??
    (sizePolicy.minimumQuantity as number | undefined) ??
    0;
  const partialExecutionAllowed =
    mandate.partialExecutionAllowed ??
    (sizePolicy.partialExecutionAllowed as boolean | undefined) ??
    true;

  const derivedWalkawayMin =
    mandate.derivedWalkawayMin ??
    Number(mandate.referencePrice) *
      (1 - (mandate.priceBandBps ?? 200) / 10_000);
  const derivedWalkawayMax =
    mandate.derivedWalkawayMax ??
    Number(mandate.referencePrice) *
      (1 + (mandate.priceBandBps ?? 200) / 10_000);

  // Bounds depend on side.
  const minPrice =
    mandate.side === "buy"
      ? Number(mandate.referencePrice)
      : derivedWalkawayMin;
  const maxPrice =
    mandate.side === "sell"
      ? Number(mandate.referencePrice)
      : derivedWalkawayMax;

  // Estimate concession consumed from the session's round count.
  const roundsUsed = session.roundNumber;
  const concessionConsumedBps = Math.round(
    Math.min(concessionBudgetBps, roundsUsed * (concessionBudgetBps / Math.max(1, session.maxRounds))),
  );

  // Resolve counterpart pattern from the session's strategy signals.
  const latestStrategySignal = session.latestStrategySignal;
  const counterpartPattern: "unknown" | "cooperative" | "resistant" =
    latestStrategySignal === "accept" ||
    latestStrategySignal === "concede" ||
    latestStrategySignal === "build_trust"
      ? "cooperative"
      : latestStrategySignal === "test_patience" ||
          latestStrategySignal === "hold_for_better_terms"
        ? "resistant"
        : "unknown";

  const timeToDeadlineMs = Math.max(
    0,
    Date.parse(session.deadline) - Date.now(),
  );
  const roundsRemaining = Math.max(
    0,
    session.maxRounds - session.roundNumber,
  );

  return {
    side: mandate.side,
    assetCode: mandate.assetCode,
    quoteAssetCode,
    objective,
    executionStyle,
    urgency: mandate.urgency,
    targetQuantity: Number(mandate.targetQuantity),
    minimumQuantity,
    partialExecutionAllowed,
    referencePrice: Number(mandate.referencePrice),
    minPrice: roundPrice(minPrice),
    maxPrice: roundPrice(maxPrice),
    maxNotional: Number(mandate.maxNotional ?? mandate.derivedNotionalCeiling ?? 1_000_000),
    concessionBudgetRemainingBps: Math.max(
      0,
      concessionBudgetBps - concessionConsumedBps,
    ),
    roundNumber: session.roundNumber,
    maxRounds: session.maxRounds,
    roundsRemaining,
    deadline: session.deadline,
    timeToDeadlineMs,
    distanceSignal: session.distanceSignal,
    counterpartPattern,
    counterpartStandingPrice: session.counterpartStandingProposal.price,
    counterpartStandingQuantity: session.counterpartStandingProposal.quantity,
    disclosableClaims: mandate.disclosableClaims,
    receivedClaims: session.disclosureProgress.receivedVerifiedClaims,
    requiredClaims: session.disclosureProgress.requiredClaims,
    trustLevel: session.trustLevel,
    approvalMode,
    operatorInstructions:
      mandate.operatorInstructions ?? mandate.operatorPrompt,
    lastOutcome,
    priorMoveRationale,
  };
}

function log(side: "buy" | "sell", message: string): void {
  const ts = new Date().toISOString();
  const tag = side.toUpperCase().padEnd(5, " ");
  console.log(`[${ts}] [${tag}] ${message}`);
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatError(err: unknown): string {
  if (err instanceof GhostBrokerApiError) {
    return `${err.status} ${err.code} ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
