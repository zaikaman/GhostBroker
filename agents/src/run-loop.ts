import {
  GhostBrokerClient,
  GhostBrokerApiError,
  type AgentPortfolio,
  type AuthSession,
  type AgentAdmission,
  type CompletedTrade,
  type TelemetryEvent,
} from "@ghostbroker/agent-client";
import type { AgentEnv } from "./env.js";
import type { Decision, LlmClient } from "./llm-decision.js";
import { buildSealedEnvelope } from "./sealed-envelope.js";
import { readIdentity } from "./identity.js";
import { loadDelegationCredential } from "./delegation.js";
import { verifyDelegationCredential } from "./vc-verifier.js";

/**
 * Shared loop runtime for the buyer and seller.
 *
 * The agent boots from an on-disk identity file (DID + keypair,
 * produced by `setup:identity`) and an on-disk W3C Verifiable
 * Credential (produced by `setup:delegation`), passes the VC to
 * the server's boundbuyer verifier, and then submits encrypted
 * intents through the regular matching pipeline.
 */

export interface AgentRunOptions {
  side: "buy" | "sell";
  env: AgentEnv;
  llm: LlmClient;
  dryRun: boolean;
  assetCode: string;
}

export interface AgentRunResult {
  outcome: "settled" | "aborted" | "max_ticks_reached" | "dry_run_complete" | "admit_failed";
  ticksRun: number;
  lastDecision: Decision | undefined;
  settlementCorrelationRef: string | undefined;
  admissionAuthorityRef: string | undefined;
  verificationMode: string | undefined;
}

export async function runAgentLoop(options: AgentRunOptions): Promise<AgentRunResult> {
  const { side, env, llm, dryRun, assetCode } = options;

  // Preflight: load the boundbuyer identity and delegation VC from
  // disk. Both files are produced by the setup:identity and
  // setup:delegation CLIs, which call the live T3N network.
  const identity = readIdentity(env.AGENT_IDENTITY_CONFIG_PATH);
  const delegation = loadDelegationCredential(env.DELEGATION_CREDENTIAL_PATH);

  log(side, `→ Using identity ${identity.did} (eth ${identity.ethAddress})`);
  log(side, `→ Delegation ${delegation.id} issued by ${delegation.issuer}`);

  // Local verification is belt-and-suspenders; the server runs
  // the authoritative verifier on admit. We never want to send a
  // malformed VC over the wire even if the local file was edited.
  const localVerification = await verifyDelegationCredential(
    delegation,
    identity.did,
    env.VC_VERIFY_MODE,
  );
  for (const warning of localVerification.warnings) {
    log(side, `  vc-warn: ${warning}`);
  }
  if (!localVerification.verified) {
    log(
      side,
      `✗ Local VC verification failed: ${localVerification.message}. Re-run npm run setup:delegation.`,
    );
    process.exit(2);
  }
  log(side, `✓ Local VC verification passed (mode: ${localVerification.mode})`);

  // Authenticate against the GhostBroker backend.
  const client = new GhostBrokerClient({ baseUrl: env.GHOSTBROKER_URL });
  let session: AuthSession;
  try {
    session = await client.authenticateWithApiKey(env.GHOSTBROKER_API_KEY);
  } catch (err) {
    log(side, `✗ Auth failed: ${formatError(err)}`);
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
      verificationMode: localVerification.mode,
    };
  }
  log(side, `✓ Authenticated as ${session.institution.displayName} (${session.institution.id})`);

  // Admit via the boundbuyer path. The VC was loaded from disk by
  // `loadDelegationCredential` and re-verified locally by
  // `verifyDelegationCredential` above. The backend runs the same
  // verifier server-side and persists the VC on the agent record
  // so submit / cancel / settlement can re-verify it on every
  // privileged action.
  let admission: AgentAdmission;
  try {
    admission = await client.admitAgent({
      institutionId: session.institution.id,
      agentDid: identity.did,
      delegationCredential: delegation,
    });
  } catch (err) {
    log(side, `✗ Admit failed: ${formatError(err)}`);
    return {
      outcome: "admit_failed",
      ticksRun: 0,
      lastDecision: undefined,
      settlementCorrelationRef: undefined,
      admissionAuthorityRef: undefined,
      verificationMode: localVerification.mode,
    };
  }
  log(side, `✓ Admitted. Authority ref: ${admission.authorityRef}`);

  // Read the live portfolio via the SDK. This is the agent's
  // primary balance source. If the call fails (e.g. transient
  // 503), we log a warning and fall back to the optional
  // AGENT_AVAILABLE_USDC / AGENT_AVAILABLE_WBTC env vars. The
  // orchestrator's balance-lock check is the real authority on
  // whether a submit will succeed; this read is informational.
  let livePortfolio: AgentPortfolio | undefined;
  try {
    livePortfolio = await client.getAgentPortfolio({
      institutionId: session.institution.id,
      agentDid: identity.did,
    });
    const usdcHolding = livePortfolio.holdings.find((h) => h.assetCode === "USDC");
    const wbtcHolding = livePortfolio.holdings.find((h) => h.assetCode === "WBTC");
    log(
      side,
      `✓ Portfolio: USDC ${usdcHolding ? usdcHolding.balance - usdcHolding.locked : 0} available ` +
        `(held ${usdcHolding?.balance ?? 0}, locked ${usdcHolding?.locked ?? 0}); ` +
        `WBTC ${wbtcHolding ? wbtcHolding.balance - wbtcHolding.locked : 0} available; ` +
        `${livePortfolio.pendingReservations.length} pending reservation(s)`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (env.AGENT_AVAILABLE_USDC === undefined || env.AGENT_AVAILABLE_WBTC === undefined) {
      log(
        side,
        `⚠ Portfolio read failed (${message}). No AGENT_AVAILABLE_* fallback set; ` +
          "the LLM will see 0 available and wait until the SDK recovers.",
      );
    } else {
      log(
        side,
        `⚠ Portfolio read failed (${message}). Using env fallback: ` +
          `USDC=${env.AGENT_AVAILABLE_USDC}, WBTC=${env.AGENT_AVAILABLE_WBTC}.`,
      );
    }
  }

  // Wire telemetry.
  client.telemetry.onMessage((event) => logTelemetry(side, event));
  client.telemetry.onError((phase, ref) =>
    log(side, `⚠ Telemetry error: ${phase} (ref: ${ref})`),
  );
  client.telemetry.connect();

  let settlementCorrelationRef: string | undefined;
  const stopOnSettle = client.telemetry.onSettled((ref) => {
    log(side, `✓ Settlement finalized: ${ref}`);
    settlementCorrelationRef = ref;
  });

  let lastDecision: Decision | undefined;
  let lastOutcome = "(start of run)";

  for (let tick = 1; tick <= env.MAX_TICKS; tick += 1) {
    log(side, `— tick ${tick}/${env.MAX_TICKS} —`);

    if (settlementCorrelationRef !== undefined) {
      stopOnSettle();
      client.telemetry.disconnect();
      return {
        outcome: "settled",
        ticksRun: tick,
        lastDecision,
        settlementCorrelationRef,
        admissionAuthorityRef: admission.authorityRef,
        verificationMode: localVerification.mode,
      };
    }

    const { items: trades } = await readTrades(client, side);
    // Refetch the portfolio on every tick so the LLM sees the
    // post-settlement balance and any new reservation amounts.
    // A failure here is non-fatal — `availableBalances` falls
    // back to the env vars or 0.
    if (client.token) {
      try {
        livePortfolio = await client.getAgentPortfolio({
          institutionId: session.institution.id,
          agentDid: identity.did,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(side, `⚠ portfolio refresh failed on tick ${tick}: ${message}`);
      }
    }
    const ctx = buildDecisionContext({
      side,
      env,
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
      log(side, `✗ LLM call failed: ${message}`);
      lastOutcome = `LLM call failed: ${message.slice(0, 80)}`;
      await sleep(env.TICK_INTERVAL_MS);
      continue;
    }
    lastDecision = decision;
    log(
      side,
      `  decision: action=${decision.action} qty=${decision.quantity} price=${decision.price} :: ${decision.reasoning}`,
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
        verificationMode: localVerification.mode,
      };
    }

    if (decision.action === "wait" || dryRun) {
      lastOutcome = dryRun
        ? `DRY_RUN: would have waited (decision=${decision.action})`
        : "wait chosen by LLM";
      await sleep(env.TICK_INTERVAL_MS);
      continue;
    }

    // Submit path.
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
      `  submitting: ${side} ${decision.quantity} ${assetCode} @ ${decision.price} USDC (envelope ${envelope.length}B, handle ${envelope.handle})`,
    );

    try {
      const accepted = await client.submitEncryptedIntent({
        institutionId: session.institution.id,
        agentDid: identity.did,
        encryptedIntentEnvelope: envelope.envelope,
        authorityRef: admission.authorityRef,
        settlementMetadata: {
          assetCode,
          side,
          quantity: decision.quantity,
          price: decision.price,
        },
      });
      log(side, `✓ Intent sealed: ${accepted.intentHandle}`);
      lastOutcome = `intent sealed (${accepted.intentHandle})`;
    } catch (err) {
      const friendly = formatError(err);
      if (err instanceof GhostBrokerApiError) {
        if (err.isAuthError) {
          log(side, `✗ ${err.code} on submit (${err.status}). Re-authenticating and continuing.`);
          await client.authenticateWithApiKey(env.GHOSTBROKER_API_KEY);
          lastOutcome = `auth retry after ${err.status}`;
          await sleep(env.TICK_INTERVAL_MS);
          continue;
        }
        if (err.status === 403) {
          log(side, `✗ 403 on submit: ${err.message}. Will wait and retry.`);
          lastOutcome = `403 on submit (${err.message.slice(0, 60)})`;
          await sleep(env.TICK_INTERVAL_MS);
          continue;
        }
        if (err.isRetryable) {
          log(side, `⚠ ${err.status} on submit; retrying next tick.`);
          lastOutcome = `${err.status} on submit (retryable)`;
          await sleep(env.TICK_INTERVAL_MS);
          continue;
        }
        log(side, `✗ submit failed: ${err.status} ${err.code} ${err.message}`);
        lastOutcome = `submit failed ${err.status}`;
        await sleep(env.TICK_INTERVAL_MS);
        continue;
      }
      log(side, `✗ submit threw: ${friendly}`);
      lastOutcome = `submit threw: ${friendly.slice(0, 60)}`;
      await sleep(env.TICK_INTERVAL_MS);
      continue;
    }

    // Wait passively for settlement.
    const settledRef = await waitForSettlement({
      client,
      session,
      side,
      intentHandle: "(submitted above)",
      timeoutMs: env.TICK_INTERVAL_MS,
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
        verificationMode: localVerification.mode,
      };
    }
    lastOutcome = "intent in flight, no settlement within one tick";
  }

  stopOnSettle();
  client.telemetry.disconnect();
  const outcome: AgentRunResult["outcome"] = dryRun
    ? "dry_run_complete"
    : "max_ticks_reached";
  return {
    outcome,
    ticksRun: env.MAX_TICKS,
    lastDecision,
    settlementCorrelationRef,
    admissionAuthorityRef: admission.authorityRef,
    verificationMode: localVerification.mode,
  };
}

interface BuildContextInput {
  side: "buy" | "sell";
  env: AgentEnv;
  completedTradeCount: number;
  tickNumber: number;
  lastOutcome: string;
  livePortfolio: AgentPortfolio | undefined;
}

/**
 * Resolve the USDC / WBTC balances the LLM should see this tick.
 *
 * Order of preference:
 *  1. Live portfolio from `client.getAgentPortfolio(...)` — the
 *     freshest source, with `balance - locked` per holding.
 *  2. Env-var fallback (`AGENT_AVAILABLE_USDC` /
 *     `AGENT_AVAILABLE_WBTC`) — only used when the SDK call
 *     failed.
 *  3. 0 — the LLM sees "0 available" and waits, which is the safe
 *     default when both the SDK and the env are silent.
 */
function availableBalances(
  portfolio: AgentPortfolio | undefined,
  env: AgentEnv,
): { usdc: number; wbtc: number } {
  if (portfolio) {
    const usdcHolding = portfolio.holdings.find((h) => h.assetCode === "USDC");
    const wbtcHolding = portfolio.holdings.find((h) => h.assetCode === "WBTC");
    return {
      usdc: usdcHolding ? Math.max(0, usdcHolding.balance - usdcHolding.locked) : 0,
      wbtc: wbtcHolding ? Math.max(0, wbtcHolding.balance - wbtcHolding.locked) : 0,
    };
  }
  return {
    usdc: env.AGENT_AVAILABLE_USDC ?? 0,
    wbtc: env.AGENT_AVAILABLE_WBTC ?? 0,
  };
}

function buildDecisionContext(input: BuildContextInput) {
  const { side, env, completedTradeCount, tickNumber, lastOutcome, livePortfolio } = input;
  const { usdc, wbtc } = availableBalances(livePortfolio, env);
  return {
    side,
    referencePriceUsdcPerWbtc: env.REFERENCE_PRICE_USDC_PER_WBTC,
    priceBandBps: env.PRICE_BAND_BPS,
    quantityMinWbtc: env.QUANTITY_MIN_WBTC,
    quantityMaxWbtc: env.QUANTITY_MAX_WBTC,
    availableUsdc: usdc,
    availableWbtc: wbtc,
    completedTradeCount,
    tickNumber,
    maxTicks: env.MAX_TICKS,
    lastOutcome,
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
      log(side, `⚠ trades fetch failed: ${err.status} ${err.code}. Assuming none.`);
    }
    return { items: [] };
  }
}

interface WaitInput {
  client: GhostBrokerClient;
  session: AuthSession;
  side: "buy" | "sell";
  intentHandle: string;
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
        if (newest) return newest.tradeRef;
      }
      lastCount = items.length;
    } catch (err) {
      if (err instanceof GhostBrokerApiError) {
        log(side, `  settlement poll: ${err.status} ${err.code}`);
      }
    }
    await sleep(2_000);
  }
  return undefined;
}

function log(side: "buy" | "sell", message: string): void {
  const ts = new Date().toISOString();
  const tag = side.toUpperCase().padEnd(5, " ");
  console.log(`[${ts}] [${tag}] ${message}`);
}

function logTelemetry(side: "buy" | "sell", event: TelemetryEvent): void {
  if (event.phase === "settlement_finalized" || event.phase === "settlement_failed") {
    log(side, `  ↪ telemetry: ${event.phase} (${event.correlationRef ?? "no-ref"})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatError(err: unknown): string {
  if (err instanceof GhostBrokerApiError) {
    return `${err.status} ${err.code} ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
