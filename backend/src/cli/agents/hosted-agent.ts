#!/usr/bin/env node
import { loadAgentEnv } from "./env.js";
import { NegotiationLlmClient } from "./negotiation-decision.js";
import { runNegotiationLoop } from "./negotiation-loop.js";
import { buildLlmChain } from "./llm/index.js";

async function main(): Promise<void> {
  const env = loadAgentEnv();

  if (!env.GHOSTBROKER_URL) {
    console.error("Missing GHOSTBROKER_URL");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_SESSION_TOKEN) {
    console.error("Missing GHOSTBROKER_SESSION_TOKEN");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_INSTITUTION_ID) {
    console.error("Missing GHOSTBROKER_INSTITUTION_ID");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_INSTITUTION_DISPLAY_NAME) {
    console.error("Missing GHOSTBROKER_INSTITUTION_DISPLAY_NAME");
    process.exit(2);
  }
  if (!env.GHOSTBROKER_INSTITUTION_TENANT_DID) {
    console.error("Missing GHOSTBROKER_INSTITUTION_TENANT_DID");
    process.exit(2);
  }
  if (!env.HOSTED_AGENT_ID) {
    console.error("Missing HOSTED_AGENT_ID");
    process.exit(2);
  }
  if (!env.HOSTED_MANDATE_ID) {
    console.error("Missing HOSTED_MANDATE_ID");
    process.exit(2);
  }
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY && !env.GROQ_API_KEY) {
    console.error(
      "Missing LLM provider credentials — set at least one of " +
        "GEMINI_API_KEY (primary), OPENAI_API_KEY (fallback #1), or " +
        "GROQ_API_KEY (fallback #2).",
    );
    process.exit(2);
  }

  const chain = buildLlmChain({
    env,
    onFallback: (event) => {
      console.warn(
        `[HOSTED] LLM fallback: ${event.from} → ${event.to ?? "(none)"} (${event.error.kind}${event.error.status !== undefined ? ` ${event.error.status}` : ""}, ${event.remaining} left)`,
      );
    },
  });
  console.log(`[HOSTED] LLM chain: ${chain.providerIds.join(" → ")}`);

  const llm = new NegotiationLlmClient({ provider: chain });

  const result = await runNegotiationLoop({
    env,
    llm,
  });

  // The runtime stdout is streamed verbatim into the backend's
  // `state.logTail`, surfaced through `GET /api/hosted-agents/:id`,
  // and rendered in the dashboard's AgentDeploymentGuide logTail
  // panel. The structured `result` carries `lastDecision` with
  // `price` and `quantity` populated — strip those fields before
  // dumping the JSON so a plaintext bid/ask never escapes the
  // TEE-boundary into an operator's dashboard. This is the source
  // fix; the wire-side guarantee is `redactLogTail` inside the
  // backend's `attachLogTail`.
  const sanitizedResult = {
    ...result,
    lastDecision:
      result.lastDecision !== undefined
        ? (() => {
            const { price: _price, quantity: _quantity, ...rest } = result.lastDecision;
            void _price;
            void _quantity;
            return rest;
          })()
        : undefined,
  };
  console.log(JSON.stringify(sanitizedResult, null, 2));
  process.exit(result.outcome === "admit_failed" ? 2 : 0);
}

main().catch((error: unknown) => {
  console.error("[HOSTED] fatal:", error);
  process.exit(1);
});
