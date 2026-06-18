#!/usr/bin/env node
/**
 * GhostBroker Seller Agent (Ghostbroker delegation flow).
 *
 * Mirror of `buyer-agent.ts` with `side="sell"`. Post-Phase
 * 1, the preflight only requires `GHOSTBROKER_URL`,
 * `GHOSTBROKER_API_KEY`, and at least one LLM provider
 * credential (Gemini preferred, OpenAI first fallback,
 * Groq last). The delegation credential + agent identity
 * are owned by the backend.
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
        `[SELLER] LLM fallback: ${event.from} → ${event.to ?? "(none)"} (${event.error.kind}${event.error.status !== undefined ? ` ${event.error.status}` : ""}, ${event.remaining} left)`,
      );
    },
  });
  console.log(`[SELLER] LLM chain: ${chain.providerIds.join(" → ")}`);
  const llm = new DecisionLlmClient({ provider: chain });

  const result = await runAgentLoop({
    side: "sell",
    env,
    llm,
    dryRun,
    assetCode: "WBTC",
  });

  console.log("\n[SELLER] run finished:");
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
  console.error("[SELLER] fatal:", err);
  process.exit(1);
});
