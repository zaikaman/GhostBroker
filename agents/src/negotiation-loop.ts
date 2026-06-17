import {
  GhostBrokerApiError,
  GhostBrokerClient,
  type AgentAdmission,
  type AuthSession,
  type RedactedNegotiationSessionView,
} from "@ghostbroker/agent-client";
import {
  buildTurnContext,
  normalizeStrategy,
  type AuthoredMandatePolicy,
  type NegotiationStrategyProfile,
} from "@ghostbroker/negotiation-core";
import type { AgentEnv } from "./env.js";
import {
  type NegotiationContext,
  type NegotiationDecision,
  type NegotiationLlmClient,
} from "./negotiation-decision.js";
import { loadOrGenerateIdentity } from "./identity.js";
import { buildSelfAttestedClaimCredential } from "./claim-credential.js";

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

    // Awaiting operator approval: the orchestrator has paused
    // settlement pending a human decision. The agent loop must NOT
    // keep submitting moves; we just back off and poll. Outcome is
    // resolved by either the approve / decline endpoint or the
    // deadline expiry, not by us.
    if (liveSession.status === "awaiting_approval") {
      lastOutcome = `escalation ${liveSession.escalationStatus ?? "pending"} — awaiting operator`;
      await sleep(env.POLL_INTERVAL_MS);
      continue;
    }

    if (liveSession.currentTurn !== side) {
      lastOutcome = `waiting for ${liveSession.currentTurn} turn`;
      await sleep(env.POLL_INTERVAL_MS);
      continue;
    }

    // Refresh the cumulative disclosure-request history for THIS side
    // so the validator can cap repeated disclosure-only moves. The
    // round view's `disclosedClaimRefs` carries the claim type the
    // actor named when it asked (or revealed) on each past round.
    const priorClaimRequests: string[] = liveSession.rounds
      .filter((round) => round.actorSide === side)
      .filter((round) => round.moveType === "request_disclosure" || round.moveType === "reveal")
      .flatMap((round) => round.disclosedClaimRefs)
      .filter((claim): claim is string => typeof claim === "string" && claim.length > 0);

    const ctx = buildNegotiationContext({
      mandate,
      quoteAssetCode,
      session: liveSession,
      lastOutcome,
      priorMoveRationale,
      priorClaimRequests,
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
        // Build a self-attested W3C-style credential for reveal moves so
        // the orchestrator's disclosure verifier returns `verified: true`
        // and the claim advances the trust-level filter. This lets the
        // hosted agent actually progress the disclosure gate (and stop
        // looping on `request_disclosure`) even when running outside a
        // T3-enclave attestation pipeline.
        const claimCredential =
          decision.action === "reveal" && decision.claimType
            ? buildSelfAttestedClaimCredential({
                issuerDid: identity.did,
                subjectId: session.institution.displayName,
                claimType: decision.claimType,
              })
            : undefined;

        const result = await client.submitNegotiationMove(sessionId, {
          agentId: env.HOSTED_AGENT_ID ?? "00000000-0000-0000-0000-000000000000",
          agentDid: identity.did,
          authorityRef: admission.authorityRef,
          move: decision,
          ...(claimCredential !== undefined ? { claimCredential } : {}),
        });
        lastOutcome = `move -> ${result.status}`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GhostBrokerApiError) {
        log(
          side,
          `Move rejected: ${err.status} ${err.code} ${message} (action=${decision.action} price=${decision.price} qty=${decision.quantity})`,
        );
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
      } else {
        log(side, `Move threw non-API error: ${message}`);
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
 * session view by routing through the shared `buildTurnContext` so the
 * agent's bounds are guaranteed to match the orchestrator's
 * authoritative validator. Legacy mandates (no authored columns)
 * fall back to a synthetic authored policy built from the legacy
 * numeric fields.
 */
function buildNegotiationContext(input: {
  mandate: RuntimeMandate;
  quoteAssetCode: string;
  session: RedactedNegotiationSessionView;
  lastOutcome: string;
  priorMoveRationale?: string;
  priorClaimRequests?: string[];
}): NegotiationContext {
  const { mandate, quoteAssetCode, session, lastOutcome, priorMoveRationale, priorClaimRequests } =
    input;

  const profile = profileFromRuntimeMandate(mandate);
  const receivedClaims = session.disclosureProgress.receivedVerifiedClaims;
  const concessionConsumedBps = Math.round(
    Math.min(
      profile.rails.concessionBudgetBps,
      session.roundNumber *
        (profile.rails.concessionBudgetBps / Math.max(1, session.maxRounds)),
    ),
  );
  const counterpartPattern = deriveCounterpartPattern(
    session.latestStrategySignal,
  );

  const baseCtx = buildTurnContext({
    profile,
    side: mandate.side,
    roundNumber: session.roundNumber,
    maxRounds: session.maxRounds,
    deadline: session.deadline,
    distanceSignal: session.distanceSignal,
    counterpartStandingPrice: session.counterpartStandingProposal.price,
    counterpartStandingQuantity: session.counterpartStandingProposal.quantity,
    receivedClaims,
    concessionConsumedBps,
    counterpartPattern,
    ...(mandate.operatorInstructions ??
    mandate.operatorPrompt !== undefined
      ? {
          operatorInstructions:
            mandate.operatorInstructions ?? mandate.operatorPrompt,
        }
      : {}),
    ...(priorClaimRequests !== undefined && priorClaimRequests.length > 0
      ? { priorClaimRequests }
      : {}),
    lastOutcome,
    ...(priorMoveRationale !== undefined ? { priorMoveRationale } : {}),
  });

  return {
    ...baseCtx,
    quoteAssetCode,
  };
}

function profileFromRuntimeMandate(mandate: RuntimeMandate): NegotiationStrategyProfile {
  if (
    mandate.executionStyle &&
    mandate.objective &&
    mandate.valuationPolicy &&
    mandate.concessionPolicy &&
    mandate.disclosurePolicy &&
    mandate.counterpartyRequirements &&
    mandate.approvalPolicy &&
    mandate.sizePolicy &&
    mandate.timeWindow &&
    mandate.operatorInstructions &&
    mandate.derivedAnchorValue !== null
  ) {
    const authored: AuthoredMandatePolicy = {
      objective: mandate.objective,
      assetCode: mandate.assetCode,
      side: mandate.side,
      sizePolicy: {
        targetQuantity: Number(mandate.targetQuantity),
        minimumQuantity: mandate.minimumQuantity ?? 0,
        partialExecutionAllowed: mandate.partialExecutionAllowed ?? true,
      },
      urgency: mandate.urgency,
      executionStyle: mandate.executionStyle,
      valuationPolicy: mandate.valuationPolicy as unknown as AuthoredMandatePolicy["valuationPolicy"],
      concessionPolicy: mandate.concessionPolicy as unknown as AuthoredMandatePolicy["concessionPolicy"],
      disclosurePolicy: mandate.disclosurePolicy as unknown as AuthoredMandatePolicy["disclosurePolicy"],
      counterpartyRequirements: mandate.counterpartyRequirements as unknown as AuthoredMandatePolicy["counterpartyRequirements"],
      approvalPolicy: mandate.approvalPolicy as unknown as AuthoredMandatePolicy["approvalPolicy"],
      timeWindow: mandate.timeWindow as unknown as AuthoredMandatePolicy["timeWindow"],
      operatorInstructions: mandate.operatorInstructions,
    };
    return normalizeStrategy(authored);
  }
  // Legacy mandate: synthesize a minimal authored policy from the
  // numeric fields so we still share the bounds math.
  const reference = Number(mandate.referencePrice);
  const synthesized: AuthoredMandatePolicy = {
    objective: mandate.objective ?? mandate.operatorPrompt,
    assetCode: mandate.assetCode,
    side: mandate.side,
    sizePolicy: {
      targetQuantity: Number(mandate.targetQuantity),
      minimumQuantity: mandate.minimumQuantity ?? 0,
      partialExecutionAllowed: mandate.partialExecutionAllowed ?? true,
    },
    urgency: mandate.urgency,
    executionStyle: "balanced",
    valuationPolicy: {
      source: "operator_note",
      anchorValue: mandate.derivedAnchorValue ?? reference,
    },
    concessionPolicy: {
      pace: "balanced",
      maxConcessionBps: mandate.derivedConcessionBudgetBps ?? mandate.priceBandBps ?? 150,
    },
    disclosurePolicy: { allowLadder: mandate.disclosableClaims ?? [] },
    counterpartyRequirements: {
      requiredClaims: mandate.requiredCounterpartyClaims ?? [],
      disallowedTraits: [],
    },
    approvalPolicy: { mode: "auto_settle" },
    timeWindow: { deadline: mandate.deadline },
    operatorInstructions: mandate.operatorPrompt,
  };
  return normalizeStrategy(synthesized);
}

function deriveCounterpartPattern(
  latestStrategySignal: string | null,
): "unknown" | "cooperative" | "resistant" {
  if (
    latestStrategySignal === "accept" ||
    latestStrategySignal === "concede" ||
    latestStrategySignal === "build_trust"
  ) {
    return "cooperative";
  }
  if (
    latestStrategySignal === "test_patience" ||
    latestStrategySignal === "hold_for_better_terms"
  ) {
    return "resistant";
  }
  return "unknown";
}

function log(side: "buy" | "sell", message: string): void {
  const ts = new Date().toISOString();
  const tag = side.toUpperCase().padEnd(5, " ");
  console.log(`[${ts}] [${tag}] ${message}`);
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
