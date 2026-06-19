#!/usr/bin/env node
/**
 * GhostBroker Buyer Agent (Ghostbroker delegation flow).
 *
 * Preflight: requires `GHOSTBROKER_URL` + `GHOSTBROKER_API_KEY`.
 * The delegation credential + agent identity are owned by
 * the backend post-Phase 1; the agent process only needs
 * the API key. At least one LLM provider credential must be
 * present (Gemini preferred, OpenAI as first fallback, Groq
 * last). See `agents/src/llm/` for the chain implementation.
 *
 * Used by:
 *   - The Phase 2.5 demo orchestrator (spawned as a child
 *     process with the demo API key in env).
 *   - Local development (`npm run buyer`).
 *
 * Usage:
 *   GHOSTBROKER_URL=http://localhost:3001 \
 *   GHOSTBROKER_API_KEY=gbk_... \
 *   GEMINI_API_KEY=sk-... \
 *   npm run buyer
 */
import { loadAgentEnv, numberEnv, booleanEnv } from "./env.js";
import { DecisionLlmClient } from "./llm-decision.js";
import { runAgentLoop } from "./run-loop.js";
import { buildLlmChain } from "./llm/index.js";

async function main(): Promise<void> {
  const env = loadAgentEnv();
  const dryRun = booleanEnv("DRY_RUN", false) || numberEnv("DRY_RUN", 0) === 1;

  preflightCredentials(env);

  const chain = buildLlmChain({
    env,
    onFallback: (event) => {
      console.warn(
        `[BUYER ] LLM fallback: ${event.from} → ${event.to ?? "(none)"} (${event.error.kind}${event.error.status !== undefined ? ` ${event.error.status}` : ""}, ${event.remaining} left)`,
      );
    },
  });
  console.log(`[BUYER ] LLM chain: ${chain.providerIds.join(" → ")}`);
  const llm = new DecisionLlmClient({ provider: chain });

  const result = await runAgentLoop({
    side: "buy",
    env,
    llm,
    dryRun,
    assetCode: "WBTC",
  });

  console.log("\n[BUYER ] run finished:");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === "aborted" || result.outcome === "admit_failed" ? 2 : 0);
}

function preflightCredentials(env: ReturnType<typeof loadAgentEnv>): void {
  if (!env.GHOSTBROKER_URL) {
    console.error("✗ Missing GHOSTBROKER_URL");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_API_KEY) {
    console.error("✗ Missing GHOSTBROKER_API_KEY");
    process.exit(2);
  }
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY && !env.GROQ_API_KEY) {
    console.error(
      "✗ Missing LLM provider credentials — set at least one of " +
        "GEMINI_API_KEY (primary), OPENAI_API_KEY (fallback #1), or " +
        "GROQ_API_KEY (fallback #2) in your shell or .env.",
    );
    process.exit(2);
  }
}

main().catch((err: unknown) => {
  console.error("[BUYER ] fatal:", err);
  process.exit(1);
});
