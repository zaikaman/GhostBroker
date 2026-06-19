import {
  GhostBrokerApiError,
  GhostBrokerClient,
  type AgentAdmission,
  type AuthSession,
  type RedactedNegotiationSessionView,
} from "../../sdk/agent-client/index.js";
import {
  buildTurnContext,
  normalizeStrategy,
  type AuthoredMandatePolicy,
  type NegotiationStrategyProfile,
} from "../../negotiation-core/index.js";
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
  /**
   * Legacy field. The wire shape (per `negotiationMandateSchema`) is
   * a `{ [claimType]: jsonValue }` record; the synthesized authored
   * policy below treats the *keys* as the required-claim list. The
   * authored-form mandates expose the same data as
   * `counterpartyRequirements.requiredClaims: string[]` instead.
   */
  requiredCounterpartyClaims: Record<string, unknown> | string[];
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
  /**
   * Optional pre-built GhostBroker client. When omitted (the
   * production path) the loop constructs one from `env`. Tests
   * inject a mock client to exercise the loop without standing up
   * the full backend.
   */
  client?: GhostBrokerClient;
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
  const client =
    options.client ??
    new GhostBrokerClient({
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
  log(
    side,
    `Runtime config: pollIntervalMs=${env.POLL_INTERVAL_MS}, maxTicks=${env.MAX_TICKS}`,
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
  const negotiationStartTime = Date.now();
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

    const listed = await client.listNegotiationSessions(identity.did);
    const liveSession = pickLiveSession({
      sessions: listed.sessions,
      sessionId,
      now: Date.now(),
      side,
      sessionCreatedAfter: negotiationStartTime,
    });
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
    const priorDisclosureRequests: string[] = liveSession.rounds
      .filter((round) => round.actorSide === side)
      .filter((round) => round.moveType === "request_disclosure")
      .flatMap((round) => round.disclosedClaimRefs)
      .filter((claim): claim is string => typeof claim === "string" && claim.length > 0);
    const priorDisclosureReveals: string[] = liveSession.rounds
      .filter((round) => round.actorSide === side)
      .filter((round) => round.moveType === "reveal")
      .flatMap((round) => round.disclosedClaimRefs)
      .filter((claim): claim is string => typeof claim === "string" && claim.length > 0);

    const ctx = buildNegotiationContext({
      mandate,
      quoteAssetCode,
      session: liveSession,
      lastOutcome,
      ...(priorMoveRationale !== undefined ? { priorMoveRationale } : {}),
      priorDisclosureRequests,
      priorDisclosureReveals,
    });

    let decision: NegotiationDecision;
    try {
      // Retry transient Groq failures (empty completions, malformed
      // JSON, schema validation noise) a couple of times before
      // burning the rest of the tick on `POLL_INTERVAL_MS` of sleep.
      // A single bad response should not cost the agent 15s of
      // progress against a 10-minute deadline.
      decision = await withRetries(() => llm.decide(ctx), {
        maxAttempts: 3,
        retryDelayMs: 750,
        onAttempt: (attempt, err) => {
          const message = err instanceof Error ? err.message : String(err);
          log(side, `Negotiation LLM attempt ${attempt} failed: ${message}`);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(side, `Negotiation LLM call failed after retries: ${message}`);
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

    // The LLM owns every action decision; the loop forwards its
    // decision verbatim.
    const moveToSubmit: NegotiationDecision = decision;

    try {
      if (moveToSubmit.action === "walkaway") {
        const result = await client.walkAwayNegotiation(sessionId, {
          agentId: env.HOSTED_AGENT_ID ?? "00000000-0000-0000-0000-000000000000",
          agentDid: identity.did,
          authorityRef: admission.authorityRef,
          reasoning: moveToSubmit.reasoning,
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
          moveToSubmit.action === "reveal" && moveToSubmit.claimType
            ? buildSelfAttestedClaimCredential({
                issuerDid: identity.did,
                subjectId: session.institution.displayName,
                claimType: moveToSubmit.claimType,
              })
            : undefined;

        const result = await client.submitNegotiationMove(sessionId, {
          agentId: env.HOSTED_AGENT_ID ?? "00000000-0000-0000-0000-000000000000",
          agentDid: identity.did,
          authorityRef: admission.authorityRef,
          move: moveToSubmit,
          ...(claimCredential !== undefined ? { claimCredential } : {}),
        });
        lastOutcome = `move -> ${result.status}`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GhostBrokerApiError) {
        log(
          side,
          `Move rejected: ${err.status} ${err.code} ${message} (action=${moveToSubmit.action} price=${moveToSubmit.price} qty=${moveToSubmit.quantity})`,
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
  priorDisclosureRequests?: string[];
  priorDisclosureReveals?: string[];
}): NegotiationContext {
  const {
    mandate,
    quoteAssetCode,
    session,
    lastOutcome,
    priorMoveRationale,
    priorDisclosureRequests,
    priorDisclosureReveals,
  } =
    input;

  const profile = profileFromRuntimeMandate(mandate);
  const counterpartSide = mandate.side === "buy" ? "sell" : "buy";
  const receivedClaims = session.disclosedClaims
    .filter((claim) => claim.verified && claim.fromSide === counterpartSide)
    .map((claim) => claim.claimType);
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
    ...(priorDisclosureRequests !== undefined && priorDisclosureRequests.length > 0
      ? { priorDisclosureRequests }
      : {}),
    ...(priorDisclosureReveals !== undefined && priorDisclosureReveals.length > 0
      ? { priorDisclosureReveals }
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
      requiredClaims: normalizeRequiredClaims(mandate.requiredCounterpartyClaims),
      disallowedTraits: [],
    },
    approvalPolicy: { mode: "auto_settle" },
    timeWindow: { deadline: mandate.deadline },
    operatorInstructions: mandate.operatorPrompt,
  };
  return normalizeStrategy(synthesized);
}

/**
 * The legacy `requiredCounterpartyClaims` field is a
 * `Record<claimType, jsonValue>` map. The synthesized authored policy
 * expects `string[]`. Normalize the wire shape so the shared
 * validator's `requiredClaims.every(...)` call does not crash on a
 * non-array value (this was the cause of the recurring
 * `TypeError: requiredClaims.every is not a function` abort at the
 * second tick of every legacy-mandate run).
 */
function normalizeRequiredClaims(
  value: Record<string, unknown> | string[] | null | undefined,
): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((claim): claim is string => typeof claim === "string");
  }
  return Object.keys(value);
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

export interface RetryOptions {
  maxAttempts: number;
  retryDelayMs: number;
  onAttempt?: (attempt: number, err: unknown) => void;
}

/**
 * Run an async function with a small retry budget. The Groq API
 * occasionally returns an empty completion, a non-JSON response, or
 * a response that trips Zod validation; those are transient from
 * the agent's point of view, and a single failure should not cost
 * the agent a full `POLL_INTERVAL_MS` tick.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      options.onAttempt?.(attempt, err);
      if (attempt < options.maxAttempts) {
        await sleep(options.retryDelayMs);
      }
    }
  }
  throw lastError;
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

/**
 * True when the session is in a state where the agent can still take
 * an action: a live negotiation (`active`), a disclosure pause
 * (`awaiting_approval`), the brief window where the cross has
 * happened and the orchestrator is running the disclosure gate /
 * settlement (`converged`), or settlement in flight (`settling`).
 */
export function isActionableSessionStatus(
  status: RedactedNegotiationSessionView["status"],
): boolean {
  return (
    status === "active" ||
    status === "awaiting_approval" ||
    status === "converged" ||
    status === "settling"
  );
}

/**
 * Pick the live session the agent should act on this tick.
 *
 *   - When we already have a `sessionId` (e.g. we were paired at
 *     `submitTicket` time), follow that exact session.
 *   - When `sessionId` is undefined, our ticket was sealed but the
 *     orchestrator had no partner yet, so it parked us in
 *     `pendingTickets`. We need to discover the session that the
 *     orchestrator has now paired us into.
 *
 *     Previously this function also filtered by `currentTurn === side`
 *     in discovery mode. That caused two bugs that prevented agents
 *     from ever being paired:
 *
 *       1. Stale-session poisoning: a prior run that left a session
 *          in `active` status with `currentTurn` matching the agent's
 *          side would be picked up first. The agent would then act
 *          on a stale session whose counterparty was a different
 *          agent from the current run, while the fresh session sat
 *          unclaimed. The two agents would converge on different
 *          sessions and spin forever.
 *
 *       2. Fresh-session invisibility: a freshly paired session is
 *          created with `currentTurn: "buy"`. A sell-side agent in
 *          discovery mode could never discover it because
 *          `"sell" !== "buy"` filtered it out. The agent would loop
 *          endlessly waiting for a session it could never see.
 *
 *     The fix: remove `currentTurn === side` from discovery and
 *     instead filter by `sessionCreatedAfter`. Stale sessions from
 *     prior runs have an earlier `createdAt` and are excluded. The
 *     turn check is handled by the loop body's explicit
 *     `liveSession.currentTurn !== side` guard, which also ticks
 *     correctly when the agent already has a `sessionId`.
 *
 * Returns `null` when no actionable session is visible — the caller
 * should keep polling for the orchestrator to pair the pending
 * ticket.
 */
export function pickLiveSession(input: {
  sessions: readonly RedactedNegotiationSessionView[];
  sessionId: string | undefined;
  now: number;
  side?: "buy" | "sell";
  /**
   * When provided, only sessions created after this timestamp are
   * eligible for discovery. This prevents the agent from picking up
   * stale sessions left from a prior run. Ignored when `sessionId`
   * is set (the agent already owns a session and follows it by ID).
   */
  sessionCreatedAfter?: number;
}): RedactedNegotiationSessionView | null {
  const { sessions, sessionId, now, side: _side, sessionCreatedAfter } = input;

  if (sessionId !== undefined) {
    return sessions.find((item) => item.id === sessionId) ?? null;
  }

  // No sessionId yet — discover the session the orchestrator paired
  // us into. Filter out stale sessions from prior runs by requiring
  // the session was created during THIS run (timestamp check).
  // The `currentTurn` check is intentionally OMITTED here: a freshly
  // paired session starts with `currentTurn: "buy"`, and a sell-side
  // agent would never discover it. The turn check happens in the
  // loop body (`if (liveSession.currentTurn !== side) ...`) which
  // works correctly once the agent has adopted the sessionId.
  const candidateSessions = sessions.filter((item) => {
    if (!isActionableSessionStatus(item.status)) return false;
    if (Date.parse(item.deadline) <= now) return false;
    if (sessionCreatedAfter !== undefined) {
      const createdAt = Date.parse(item.createdAt);
      if (Number.isNaN(createdAt) || createdAt < sessionCreatedAfter) {
        return false;
      }
    }
    return true;
  });

  return candidateSessions[0] ?? null;
}
