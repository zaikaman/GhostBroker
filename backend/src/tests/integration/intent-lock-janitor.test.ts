import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntentLockJanitor } from "../../services/intent-lock-janitor.js";
import { PortfolioService } from "../../services/portfolio.service.js";
import { TelemetryBus } from "../../services/telemetry-bus.js";
import { InMemoryIntentLockClient } from "../support/in-memory-intent-lock-client.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";

const institutionId = "00000000-0000-4000-8000-000000000701";
const agentDid = "did:t3n:agent:janitor-test";

function seedLock(
  client: InMemoryIntentLockClient,
  params: {
    intentHandle: string;
    amount: number;
    ageMs: number;
  },
): void {
  client.seed({
    intent_handle: params.intentHandle,
    institution_id: institutionId,
    asset_code: "USDC",
    amount: params.amount.toString(),
    correlation_ref: `corr_${params.intentHandle}`,
    agent_did: agentDid,
    created_at: new Date(Date.now() - params.ageMs).toISOString(),
  });
}

describe("IntentLockJanitor", () => {
  let portfolioClient: InMemoryPortfolioClient;
  let lockClient: InMemoryIntentLockClient;
  let portfolioService: PortfolioService;
  let janitor: IntentLockJanitor;
  let telemetry: TelemetryBus;

  beforeEach(() => {
    portfolioClient = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId,
        assetCode: "USDC",
        balance: 1_000_000,
      }),
    ]);
    lockClient = new InMemoryIntentLockClient();
    portfolioService = new PortfolioService(
      portfolioClient as never,
      "USDC",
    );
    telemetry = new TelemetryBus();
    janitor = new IntentLockJanitor(lockClient, portfolioService, {
      telemetryBus: telemetry,
      // Use a long TTL so we don't accidentally sweep rows
      // that are still within the live window.
      lockTtlMs: 5 * 60 * 1000,
      // Long sweep interval — we drive sweeps manually.
      sweepIntervalMs: 60 * 60 * 1000,
    });
  });

  afterEach(() => {
    janitor.stop();
  });

  it("releases a lock whose ref is older than the TTL", async () => {
    seedLock(lockClient, {
      intentHandle: "intent_old",
      amount: 5000,
      ageMs: 6 * 60 * 1000, // 6 min ago, older than 5 min TTL
    });

    const swept = await janitor.sweep();
    expect(swept).toBe(1);
    expect(lockClient.rows).toHaveLength(0);

    const portfolio = await portfolioService.getPortfolio(institutionId);
    expect(portfolio.holdings[0]).toEqual({
      assetCode: "USDC",
      balance: 1_000_000,
      locked: 0, // released
    });
  });

  it("ignores locks whose ref is still within the TTL", async () => {
    seedLock(lockClient, {
      intentHandle: "intent_fresh",
      amount: 5000,
      ageMs: 30 * 1000, // 30s ago, well within TTL
    });

    const swept = await janitor.sweep();
    expect(swept).toBe(0);
    // The ref is preserved — the orchestrator is still alive
    // and may delete it on cancel/match/expire.
    expect(lockClient.rows).toHaveLength(1);
    // The sweeper does not touch `portfolios.locked` for fresh
    // locks. (In production, the lock is placed by
    // `submitIntent` before the ref is created; the sweeper
    // never acquires locks, only releases them.)
    const portfolio = await portfolioService.getPortfolio(institutionId);
    expect(portfolio.holdings[0]?.locked).toBe(0);
  });

  it("sweeps multiple locks in one pass", async () => {
    seedLock(lockClient, {
      intentHandle: "intent_1",
      amount: 1000,
      ageMs: 6 * 60 * 1000,
    });
    seedLock(lockClient, {
      intentHandle: "intent_2",
      amount: 2000,
      ageMs: 7 * 60 * 1000,
    });
    seedLock(lockClient, {
      intentHandle: "intent_3",
      amount: 3000,
      ageMs: 30 * 1000, // fresh
    });

    const swept = await janitor.sweep();
    expect(swept).toBe(2);
    expect(lockClient.rows).toHaveLength(1);
    expect(lockClient.rows[0]?.intent_handle).toBe("intent_3");

    // The fresh ref is preserved; the two old refs have been
    // released (their `releaseBalance` is clamped at zero
    // because the test seeded no actual lock amount in
    // `portfolios.locked`).
    const portfolio = await portfolioService.getPortfolio(institutionId);
    expect(portfolio.holdings[0]?.locked).toBe(0);
  });

  it("emits a telemetry event per swept lock", async () => {
    seedLock(lockClient, {
      intentHandle: "intent_t1",
      amount: 1000,
      ageMs: 6 * 60 * 1000,
    });

    // `exactOptionalPropertyTypes` is enabled in tsconfig, so
    // `event.agentId` is `string | undefined` from the listener
    // and cannot be assigned to a plain `agentId?: string` slot.
    // The local receive type makes the `| undefined` explicit so
    // the subscription callback can pass the value through as-is.
    const received: { phase: string; institutionId: string; agentId?: string | undefined }[] = [];
    telemetry.subscribe((event) => {
      received.push({
        phase: event.phase,
        institutionId: event.institutionId,
        agentId: event.agentId,
      });
    });

    await janitor.sweep();

    const lockReleasedEvents = received.filter(
      (e) => e.phase === "intent_lock_released",
    );
    expect(lockReleasedEvents).toHaveLength(1);
    expect(lockReleasedEvents[0]?.institutionId).toBe(institutionId);
    expect(lockReleasedEvents[0]?.agentId).toBe(agentDid);
  });

  it("is idempotent — running sweep twice does not double-release", async () => {
    seedLock(lockClient, {
      intentHandle: "intent_dup",
      amount: 1000,
      ageMs: 6 * 60 * 1000,
    });

    const firstSweep = await janitor.sweep();
    expect(firstSweep).toBe(1);
    expect(await portfolioService.getPortfolio(institutionId)).toEqual({
      institutionId,
      holdings: [{ assetCode: "USDC", balance: 1_000_000, locked: 0 }],
    });

    // Second sweep: no rows to find, no further state change.
    const secondSweep = await janitor.sweep();
    expect(secondSweep).toBe(0);
  });

  it("continues sweeping if one row's release fails", async () => {
    // Use a lock amount that exceeds available balance so
    // releaseBalance is a no-op (clamped at zero). The sweep
    // should still delete the ref.
    seedLock(lockClient, {
      intentHandle: "intent_safe",
      amount: 1000,
      ageMs: 6 * 60 * 1000,
    });
    seedLock(lockClient, {
      intentHandle: "intent_oversize",
      // Larger than the account balance. `releaseBalance`
      // clamps at zero (no throw), so the sweep continues.
      amount: 9_999_999,
      ageMs: 6 * 60 * 1000,
    });

    const swept = await janitor.sweep();
    expect(swept).toBe(2);
    expect(lockClient.rows).toHaveLength(0);
  });

  it("stop() prevents future sweeps from running on the timer", async () => {
    // Construct a janitor with a very short sweep interval.
    const fastJanitor = new IntentLockJanitor(
      lockClient,
      portfolioService,
      { sweepIntervalMs: 10, lockTtlMs: 1 },
    );
    fastJanitor.stop();
    // Wait a tick and confirm the timer never ran.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fastJanitor.getSweptCount()).toBe(0);
  });
});
