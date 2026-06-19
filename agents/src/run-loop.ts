import {
  GhostBrokerApiError,
  GhostBrokerClient,
  type AgentAdmission,
  type AgentPortfolio,
  type AuthSession,
  type CompletedTrade,
  type TelemetryEvent,
} from "@ghostbroker/agent-client";
import type { AgentEnv } from "./env.js";
import type { Decision, DecisionContext, LlmClient } from "./llm-decision.js";
import { loadOrGenerateIdentity } from "./identity.js";
import { buildSealedEnvelope } from "./sealed-envelope.js";

/*
 * Legacy strategy fallbacks — used only by the legacy buyer/seller loop.
 * The hosted negotiator (negotiation-loop.ts) reads strategy from the
 * mandate fetched at startup. These process.env reads keep the legacy
 * scripts compiling after the env schema was stripped of strategy fields.
 */
function legacyNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const LEGACY_REFERENCE_PRICE = legacyNumber("AGENT_REFERENCE_PRICE", legacyNumber("REFERENCE_PRICE", 70_000));
const LEGACY_PRICE_BAND_BPS = legacyNumber("PRICE_BAND_BPS", 200);
// The matching contract now (v0.4.0+) accepts fractional decimals
// on the wire (`"0.0001"` etc.), so the legacy buyer/seller scripts
// can use the same sub-unit fill size the hosted-mandate path
// negotiates. Default to 0.0001 WBTC; the test institutions have
// plenty on either side at any sane price.
const LEGACY_QUANTITY_MIN = legacyNumber("AGENT_QUANTITY_MIN", legacyNumber("QUANTITY_MIN", 0.0001));
const LEGACY_QUANTITY_MAX = legacyNumber("AGENT_QUANTITY_MAX", legacyNumber("QUANTITY_MAX", 0.0001));
const LEGACY_TICK_INTERVAL_MS = legacyNumber("TICK_INTERVAL_MS", 15_000);
const LEGACY_OPERATOR_PROMPT = process.env.AGENT_OPERATOR_PROMPT ?? undefined;

export interface AgentRunOptions {
  side: "buy" | "sell";
  env: AgentEnv;
  llm: LlmClient;
  dryRun: boolean;
  assetCode: string;
  quoteAssetCode?: string;
}

export interface AgentRunResult {
  outcome: "settled" | "aborted" | "max_ticks_reached" | "dry_run_complete" | "admit_failed";
  ticksRun: number;
  lastDecision: Decision | undefined;
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

export async function runAgentLoop(options: AgentRunOptions): Promise<AgentRunResult> {
  const { side, env, llm, dryRun, assetCode, quoteAssetCode = env.AGENT_QUOTE_ASSET_CODE } = options;
  const identity = loadOrGenerateIdentity(env.AGENT_IDENTITY_CONFIG_PATH);

  log(side, `Hosted agent booting with DID ${identity.did}`);

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
    log(side, `Authentication failed: ${formatError(err)}`);
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
    };
  }
  log(side, `Authenticated for ${session.institution.displayName}`);

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
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
    };
  }
  log(side, `Admitted with authority ${admission.authorityRef}`);

  let livePortfolio: AgentPortfolio | undefined;
  try {
    livePortfolio = await client.getAgentPortfolio({
      institutionId: session.institution.id,
      agentDid: identity.did,
    });
    log(side, describePortfolio(livePortfolio, assetCode, quoteAssetCode));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      env.AGENT_AVAILABLE_BASE_BALANCE === undefined &&
      env.AGENT_AVAILABLE_QUOTE_BALANCE === undefined
    ) {
      log(side, `Portfolio read failed (${message}); using zero balances until recovery.`);
    } else {
      log(
        side,
        `Portfolio read failed (${message}); using fallback balances ${assetCode}=${env.AGENT_AVAILABLE_BASE_BALANCE ?? 0}, ${quoteAssetCode}=${env.AGENT_AVAILABLE_QUOTE_BALANCE ?? 0}.`,
      );
    }
  }

  client.telemetry.onMessage((event) => logTelemetry(side, event));
  client.telemetry.onError((phase, ref) =>
    log(side, `Telemetry error: ${phase} (${ref ?? "no-ref"})`),
  );
  client.telemetry.connect();

  let settlementCorrelationRef: string | undefined;
  const stopOnSettle = client.telemetry.onSettled((ref) => {
    settlementCorrelationRef = ref;
    log(side, `Settlement finalized: ${ref}`);
  });

  let lastDecision: Decision | undefined;
  let lastOutcome = "(start of run)";

  for (let tick = 1; tick <= env.MAX_TICKS; tick += 1) {
    log(side, `Tick ${tick}/${env.MAX_TICKS}`);

    if (settlementCorrelationRef !== undefined) {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "settled",
        ticksRun: tick,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }

    const { items: trades } = await readTrades(client, side);
    if (client.token) {
      try {
        livePortfolio = await client.getAgentPortfolio({
          institutionId: session.institution.id,
          agentDid: identity.did,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(side, `Portfolio refresh failed on tick ${tick}: ${message}`);
      }
    }

    const ctx = buildDecisionContext({
      side,
      env,
      assetCode,
      quoteAssetCode,
      completedTradeCount: trades.length,
      tickNumber: tick,
      lastOutcome,
      livePortfolio,
    });

    let decision: Decision;
    try {
      decision = await llm.decide(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(side, `LLM call failed: ${message}`);
      lastOutcome = `LLM call failed: ${message.slice(0, 80)}`;
      await sleep(LEGACY_TICK_INTERVAL_MS);
      continue;
    }

    lastDecision = decision;
    log(
      side,
      `Decision ${decision.action} qty=${decision.quantity} price=${decision.price} (${decision.reasoning})`,
    );

    if (decision.action === "abort") {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "aborted",
        ticksRun: tick,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }

    if (decision.action === "wait" || dryRun) {
      lastOutcome = dryRun
        ? `DRY_RUN: would submit ${decision.quantity} ${assetCode} @ ${decision.price}`
        : "wait chosen by LLM";
      await sleep(LEGACY_TICK_INTERVAL_MS);
      continue;
    }

    const envelope = buildSealedEnvelope({
      institutionId: session.institution.id,
      agentDid: identity.did,
      authorityRef: admission.authorityRef,
      assetCode,
      side,
      quantity: decision.quantity,
      price: decision.price,
    });
    log(
      side,
      `Submitting ${side} ${decision.quantity} ${assetCode} @ ${decision.price} ${quoteAssetCode} (envelope ${envelope.length}B, handle ${envelope.handle})`,
    );

    try {
      const accepted = await client.submitEncryptedIntent({
        institutionId: session.institution.id,
        agentDid: identity.did,
        encryptedIntentEnvelope: envelope.envelope,
        authorityRef: admission.authorityRef,
      });
      log(side, `Intent sealed: ${accepted.intentHandle}`);
      lastOutcome = `intent sealed (${accepted.intentHandle})`;
    } catch (err) {
      const friendly = formatError(err);
      if (err instanceof GhostBrokerApiError) {
        if (err.isAuthError) {
          if (env.GHOSTBROKER_API_KEY) {
            log(side, `Submit auth error ${err.status}; refreshing session.`);
            await client.authenticateWithApiKey(env.GHOSTBROKER_API_KEY);
            lastOutcome = `auth retry after ${err.status}`;
          } else {
            log(side, `Submit auth error ${err.status}; hosted session cannot be refreshed in-process.`);
            lastOutcome = `auth failed ${err.status}`;
          }
          await sleep(LEGACY_TICK_INTERVAL_MS);
          continue;
        }
        if (err.status === 403) {
          log(side, `Submit rejected with 403; waiting for next tick.`);
          lastOutcome = `403 on submit (${err.message.slice(0, 60)})`;
          await sleep(LEGACY_TICK_INTERVAL_MS);
          continue;
        }
        if (err.isRetryable) {
          log(side, `Retryable submit failure ${err.status}; retrying next tick.`);
          lastOutcome = `${err.status} on submit (retryable)`;
          await sleep(LEGACY_TICK_INTERVAL_MS);
          continue;
        }
        log(side, `Submit failed: ${err.status} ${err.code} ${err.message}`);
        lastOutcome = `submit failed ${err.status}`;
        await sleep(LEGACY_TICK_INTERVAL_MS);
        continue;
      }
      log(side, `Submit threw: ${friendly}`);
      lastOutcome = `submit threw: ${friendly.slice(0, 60)}`;
      await sleep(LEGACY_TICK_INTERVAL_MS);
      continue;
    }

    const settledRef = await waitForSettlement({
      client,
      side,
      timeoutMs: LEGACY_TICK_INTERVAL_MS,
    });
    if (settledRef) {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "settled",
        ticksRun: tick,
        lastDecision,
        settlementCorrelationRef: settledRef,
        admissionAuthorityRef: admission.authorityRef,
      };
    }
    lastOutcome = "intent in flight, no settlement within one tick";
  }

  stopOnSettle();
  client.telemetry.disconnect();
  return {
    outcome: dryRun ? "dry_run_complete" : "max_ticks_reached",
    ticksRun: env.MAX_TICKS,
    lastDecision,
    settlementCorrelationRef,
    admissionAuthorityRef: admission.authorityRef,
  };
}

interface BuildContextInput {
  side: "buy" | "sell";
  env: AgentEnv;
  assetCode: string;
  quoteAssetCode: string;
  completedTradeCount: number;
  tickNumber: number;
  lastOutcome: string;
  livePortfolio: AgentPortfolio | undefined;
}

function findAvailableBalance(portfolio: AgentPortfolio | undefined, assetCode: string): number {
  if (!portfolio) {
    return 0;
  }
  const holding = portfolio.holdings.find((item) => item.assetCode === assetCode);
  if (!holding) {
    return 0;
  }
  return Math.max(0, holding.balance - holding.locked);
}

function availableBalances(
  portfolio: AgentPortfolio | undefined,
  env: AgentEnv,
  assetCode: string,
  quoteAssetCode: string,
): { base: number; quote: number } {
  if (portfolio) {
    return {
      base: findAvailableBalance(portfolio, assetCode),
      quote: findAvailableBalance(portfolio, quoteAssetCode),
    };
  }
  return {
    base: env.AGENT_AVAILABLE_BASE_BALANCE ?? 0,
    quote: env.AGENT_AVAILABLE_QUOTE_BALANCE ?? 0,
  };
}

function buildDecisionContext(input: BuildContextInput): DecisionContext {
  const { side, env, assetCode, quoteAssetCode, completedTradeCount, tickNumber, lastOutcome, livePortfolio } = input;
  const { base, quote } = availableBalances(livePortfolio, env, assetCode, quoteAssetCode);
  const minPrice = roundPrice(LEGACY_REFERENCE_PRICE * (1 - LEGACY_PRICE_BAND_BPS / 10_000));
  const maxPrice = roundPrice(LEGACY_REFERENCE_PRICE * (1 + LEGACY_PRICE_BAND_BPS / 10_000));

  return {
    side,
    assetCode,
    quoteAssetCode,
    referencePrice: LEGACY_REFERENCE_PRICE,
    priceBandBps: LEGACY_PRICE_BAND_BPS,
    minPrice,
    maxPrice,
    quantityMin: LEGACY_QUANTITY_MIN,
    quantityMax: LEGACY_QUANTITY_MAX,
    availableQuoteBalance: quote,
    availableBaseBalance: base,
    completedTradeCount,
    tickNumber,
    maxTicks: env.MAX_TICKS,
    lastOutcome,
    operatorPrompt: LEGACY_OPERATOR_PROMPT,
  };
}

async function readTrades(
  client: GhostBrokerClient,
  side: "buy" | "sell",
): Promise<{ items: CompletedTrade[] }> {
  try {
    return await client.getCompletedTrades();
  } catch (err) {
    if (err instanceof GhostBrokerApiError) {
      log(side, `Trades fetch failed: ${err.status} ${err.code}. Assuming none.`);
    }
    return { items: [] };
  }
}

interface WaitInput {
  client: GhostBrokerClient;
  side: "buy" | "sell";
  timeoutMs: number;
}

async function waitForSettlement(input: WaitInput): Promise<string | undefined> {
  const { client, side, timeoutMs } = input;
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() < deadline) {
    try {
      const { items } = await client.getCompletedTrades();
      if (items.length > lastCount) {
        const newest = items[0];
        if (newest) {
          return newest.tradeRef;
        }
      }
      lastCount = items.length;
    } catch (err) {
      if (err instanceof GhostBrokerApiError) {
        log(side, `Settlement poll: ${err.status} ${err.code}`);
      }
    }
    await sleep(2_000);
  }
  return undefined;
}

function describePortfolio(
  portfolio: AgentPortfolio,
  assetCode: string,
  quoteAssetCode: string,
): string {
  const quote = portfolio.holdings.find((holding) => holding.assetCode === quoteAssetCode);
  const base = portfolio.holdings.find((holding) => holding.assetCode === assetCode);
  return (
    `Portfolio ${quoteAssetCode}=${quote ? quote.balance - quote.locked : 0} available, ` +
    `${assetCode}=${base ? base.balance - base.locked : 0} available, ` +
    `${portfolio.pendingReservations.length} pending reservation(s)`
  );
}

function log(side: "buy" | "sell", message: string): void {
  const ts = new Date().toISOString();
  const tag = side.toUpperCase().padEnd(5, " ");
  console.log(`[${ts}] [${tag}] ${message}`);
}

function logTelemetry(side: "buy" | "sell", event: TelemetryEvent): void {
  if (event.phase === "settlement_finalized" || event.phase === "settlement_failed") {
    log(side, `Telemetry ${event.phase} (${event.correlationRef ?? "no-ref"})`);
  }
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
