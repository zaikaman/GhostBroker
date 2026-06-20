export {
  LlmProviderError,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderErrorKind,
  type LlmRequest,
  type LlmResponse,
  type LlmRole,
} from "./types.js";
export { GeminiLlmProvider, type GeminiProviderOptions } from "./gemini-client.js";
export { OpenAILlmProvider, type OpenAIProviderOptions } from "./openai-client.js";
export { GroqLlmProvider, type GroqProviderOptions } from "./groq-client.js";
export {
  AggregateLlmError,
  FallbackLlmProvider,
  type FallbackChainOptions,
  type FallbackEvent,
  type FallbackEventKind,
  type FallbackListener,
} from "./fallback-chain.js";

import type { AgentEnv } from "../env.js";
import type { LlmProvider } from "./types.js";
import { GeminiLlmProvider } from "./gemini-client.js";
import { OpenAILlmProvider } from "./openai-client.js";
import { GroqLlmProvider } from "./groq-client.js";
import { FallbackLlmProvider, type FallbackListener } from "./fallback-chain.js";

export const DEFAULT_PROVIDER_CHAIN = ["gemini", "openai", "groq"] as const;

export type ProviderId = (typeof DEFAULT_PROVIDER_CHAIN)[number];

const SUPPORTED_PROVIDER_IDS: ReadonlySet<string> = new Set<string>(DEFAULT_PROVIDER_CHAIN);

/**
 * Parse the `LLM_PROVIDER_CHAIN` env value. Accepts a comma-separated
 * list such as `gemini,openai,groq` or `groq,openai`. Whitespace is
 * trimmed and unknown provider ids are dropped with a console warning.
 *
 * When unset or empty, returns the default chain. When every id is
 * unknown, also returns the default chain (we don't want a typo to
 * leave the agent with zero providers).
 */
export function parseProviderChain(raw: string | undefined): ProviderId[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [...DEFAULT_PROVIDER_CHAIN];
  }
  const parsed = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (parsed.length === 0) return [...DEFAULT_PROVIDER_CHAIN];

  const known: ProviderId[] = [];
  const unknown: string[] = [];
  for (const token of parsed) {
    if (SUPPORTED_PROVIDER_IDS.has(token)) {
      const id = token as ProviderId;
      if (!known.includes(id)) known.push(id);
    } else {
      unknown.push(token);
    }
  }
  if (unknown.length > 0) {
    console.warn(
      `[llm] LLM_PROVIDER_CHAIN ignored unknown providers: ${unknown.join(", ")}. ` +
        `Supported: ${DEFAULT_PROVIDER_CHAIN.join(", ")}.`,
    );
  }
  if (known.length === 0) return [...DEFAULT_PROVIDER_CHAIN];
  return known;
}

export interface BuildLlmChainOptions {
  env: AgentEnv;
  onFallback?: FallbackListener;
  fetchImpl?: typeof fetch;
}

/**
 * Build the production LLM fallback chain from the agent env.
 *
 * Provider credentials are taken from `env` and the chain order from
 * `env.LLM_PROVIDER_CHAIN` (default: `gemini,openai,groq`). Providers
 * whose credentials are missing are silently dropped from the chain;
 * the preflight in each entry point (`buyer-agent.ts`, etc.) ensures
 * at least one credential is present, otherwise the agent refuses
 * to start with a clear message.
 */
export function buildLlmChain(options: BuildLlmChainOptions): FallbackLlmProvider {
  const { env, onFallback, fetchImpl } = options;
  const order = parseProviderChain(env.LLM_PROVIDER_CHAIN);
  const fetchOpts = fetchImpl === undefined ? {} : { fetchImpl };

  const providers: LlmProvider[] = [];
  for (const id of order) {
    const provider = buildProvider(id, env, fetchOpts);
    if (provider !== undefined) providers.push(provider);
  }

  if (providers.length === 0) {
    throw new Error(
      "No LLM providers configured. Set (GEMINI_API_KEY + GEMINI_BASE_URL), " +
        "(OPENAI_API_KEY + OPENAI_BASE_URL), or (GROQ_API_KEY + GROQ_BASE_URL) " +
        "(or a combination) in the agent environment. Every provider requires " +
        "BOTH the credential and an explicit endpoint — there are no implicit defaults.",
    );
  }

  return new FallbackLlmProvider({ providers, ...(onFallback ? { onFallback } : {}) });
}

function buildProvider(
  id: ProviderId,
  env: AgentEnv,
  fetchOpts: { fetchImpl?: typeof fetch },
): LlmProvider | undefined {
  switch (id) {
    case "gemini": {
      if (!env.GEMINI_API_KEY || !env.GEMINI_BASE_URL) return undefined;
      return new GeminiLlmProvider({
        apiKey: env.GEMINI_API_KEY,
        baseUrl: env.GEMINI_BASE_URL,
        ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}),
        ...fetchOpts,
      });
    }
    case "openai": {
      if (!env.OPENAI_API_KEY || !env.OPENAI_BASE_URL) return undefined;
      return new OpenAILlmProvider({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        ...(env.OPENAI_MODEL ? { model: env.OPENAI_MODEL } : {}),
        ...fetchOpts,
      });
    }
    case "groq": {
      if (!env.GROQ_API_KEY || !env.GROQ_BASE_URL) return undefined;
      return new GroqLlmProvider({
        apiKey: env.GROQ_API_KEY,
        baseUrl: env.GROQ_BASE_URL,
        ...(env.GROQ_MODEL ? { model: env.GROQ_MODEL } : {}),
        ...fetchOpts,
      });
    }
    default:
      return undefined;
  }
}
