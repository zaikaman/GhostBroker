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

interface RuntimeMandate {
  id: string;
  assetCode: string;
  side: "buy" | "sell";
  targetQuantity: string;
  referencePrice: string;
  priceBandBps: number;
  maxNotional: string;
  urgency: "low" | "normal" | "high" | "critical";
  deadline: string;
  disclosableClaims: string[];
  requiredCounterpartyClaims: Record<string, unknown>;
  counterpartyConstraints: Record<string, unknown>;
  operatorPrompt: string;
  policyHash: string;
}

export interface NegotiationLoopOptions {
  env: AgentEnv;
  llm: NegotiationLlmClient;
}

export interface NegotiationLoopResult {
  outcome: "settled" | "walked_away" | "expired" | "max_ticks_reached" | "admit_failed";
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
  const response = await fetch(`${env.GHOSTBROKER_URL}/api/agents/${env.HOSTED_AGENT_ID}/mandate`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${env.GHOSTBROKER_SESSION_TOKEN}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Hosted mandate lookup failed (${response.status}): ${body || response.statusText}`);
  }

  const mandate = (await response.json()) as RuntimeMandate;
  if (mandate.id !== mandateId) {
    throw new Error(`Hosted mandate mismatch: expected ${mandateId}, got ${mandate.id}`);
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
    log(
      side,
      `Decision ${decision.action} qty=${decision.quantity ?? 0} price=${decision.price ?? 0} (${decision.reasoning})`,
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

function buildNegotiationContext(input: {
  mandate: RuntimeMandate;
  quoteAssetCode: string;
  session: RedactedNegotiationSessionView;
  lastOutcome: string;
}): NegotiationContext {
  const { mandate, quoteAssetCode, session, lastOutcome } = input;
  const referencePrice = Number(mandate.referencePrice);
  const targetQuantity = Number(mandate.targetQuantity);
  const maxNotional = Number(mandate.maxNotional);
  const minPrice = roundPrice(referencePrice * (1 - mandate.priceBandBps / 10_000));
  const maxPrice = roundPrice(referencePrice * (1 + mandate.priceBandBps / 10_000));

  return {
    side: mandate.side,
    assetCode: mandate.assetCode,
    quoteAssetCode,
    targetQuantity,
    referencePrice,
    priceBandBps: mandate.priceBandBps,
    minPrice,
    maxPrice,
    maxNotional,
    urgency: mandate.urgency,
    roundNumber: session.roundNumber,
    maxRounds: session.maxRounds,
    distanceSignal: session.distanceSignal,
    counterpartStandingPrice: session.counterpartStandingProposal.price,
    counterpartStandingQuantity: session.counterpartStandingProposal.quantity,
    disclosableClaims: mandate.disclosableClaims,
    receivedClaims: session.disclosedClaims.map((claim) => claim.claimType),
    requiredClaims: Object.keys(mandate.requiredCounterpartyClaims),
    operatorPrompt: mandate.operatorPrompt,
    lastOutcome,
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
