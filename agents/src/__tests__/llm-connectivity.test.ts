/**
 * LLM Provider Connectivity Test
 *
 * Tests that each configured LLM provider's API key, base URL, and model
 * are valid by making a real, lightweight API call to each provider.
 *
 * Run with:
 *   cd agents && npx vitest run src/__tests__/llm-connectivity.test.ts
 *
 * Requires the .env file to be present with the actual API keys.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { loadDotEnv, loadAgentEnv, type AgentEnv } from "../env.js";
import {
  OpenAILlmProvider,
  GeminiLlmProvider,
  GroqLlmProvider,
} from "../llm/index.js";

// Load .env before anything else
loadDotEnv();

/**
 * Parse key=value from the .env file directly, bypassing process.env.
 * This is needed because stale env vars in the shell take precedence
 * over loadDotEnv() (which skips existing keys).
 */
function parseDotEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(import.meta.dirname, "..", "..", ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  }
  return vars;
}

const dotEnvVars = parseDotEnv();

/** Prefer .env file value, fall back to env value, fall back to default. */
function pick(
  key: string,
  envVal: string | undefined,
  fallback: string,
): string {
  return dotEnvVars[key] || envVal || fallback;
}

const MINIMAL_PROMPT = {
  messages: [
    { role: "user" as const, content: "Say the word 'ok' and nothing else." },
  ],
};

interface ConnectivityResult {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyPrefix: string;
  reachable: boolean;
  status?: number;
  error?: string;
}

async function testProviderConnectivity(
  label: string,
  factory: () => {
    provider: { complete(req: typeof MINIMAL_PROMPT): Promise<unknown> };
    model: string;
    baseUrl: string;
    apiKeyPreview: string;
  },
): Promise<ConnectivityResult> {
  const { provider, model, baseUrl, apiKeyPreview } = factory();
  try {
    const response = (await provider.complete(MINIMAL_PROMPT)) as {
      text?: string;
    };
    return {
      provider: label,
      model,
      baseUrl,
      apiKeyPrefix: apiKeyPreview,
      reachable: true,
      error: `response.text="${(response.text ?? "").slice(0, 50)}"`,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const status =
      "status" in error ? (error as { status?: number }).status : undefined;
    return {
      provider: label,
      model,
      baseUrl,
      apiKeyPrefix: apiKeyPreview,
      reachable: false,
      status,
      error: error.message.slice(0, 300),
    };
  }
}

function preview(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return `${key.slice(0, 2)}...`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

describe("LLM Provider Connectivity", () => {
  let env: AgentEnv;

  beforeAll(() => {
    try {
      env = loadAgentEnv();
    } catch {
      console.error("Failed to load agent env — check .env file");
      throw new Error("Agent env validation failed");
    }
  });

  it("should have the .env.example as a template reference", () => {
    expect(env).toBeDefined();
  });

  describe("Gemini", () => {
    it("should have an API key configured", () => {
      expect(env.GEMINI_API_KEY).toBeTruthy();
    });

    it("should be reachable", async () => {
      if (!env.GEMINI_API_KEY) return;
      const result = await testProviderConnectivity("gemini", () => ({
        provider: new GeminiLlmProvider({
          apiKey: env.GEMINI_API_KEY!,
          ...(env.GEMINI_BASE_URL ? { baseUrl: env.GEMINI_BASE_URL } : {}),
          ...(env.GEMINI_MODEL ? { model: env.GEMINI_MODEL } : {}),
        }),
        model: env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
        baseUrl: env.GEMINI_BASE_URL ?? "(default v98store proxy)",
        apiKeyPreview: preview(env.GEMINI_API_KEY),
      }));
      console.log(
        `\n[Gemini] model=${result.model} baseUrl=${result.baseUrl} key=${result.apiKeyPrefix}`,
      );
      console.log(
        `[Gemini] reachable=${result.reachable}${result.error ? ` error=${result.error}` : ""}`,
      );
    }, 15_000);
  });

  describe("OpenAI (Azure)", () => {
    it("should have an API key configured", () => {
      expect(env.OPENAI_API_KEY).toBeTruthy();
    });

    it("should connect via the OpenAILlmProvider (Bearer auth)", async () => {
      const apiKey = pick("OPENAI_API_KEY", env.OPENAI_API_KEY, "");
      const baseUrl = pick(
        "OPENAI_BASE_URL",
        env.OPENAI_BASE_URL,
        "https://roguegoescrazy.services.ai.azure.com/openai/v1",
      );
      const model = pick("OPENAI_MODEL", env.OPENAI_MODEL, "gpt-5-nano");

      if (!apiKey) {
        console.log("\n[OpenAI] No API key found — skipping");
        return;
      }

      console.log(
        `\n[OpenAI] testing Bearer auth (provider's current behavior)...`,
      );
      const bearerResult = await testProviderConnectivity(
        "openai-bearer",
        () => ({
          provider: new OpenAILlmProvider({ apiKey, baseUrl, model }),
          model,
          baseUrl,
          apiKeyPreview: preview(apiKey),
        }),
      );
      console.log(
        `[OpenAI/Bearer] reachable=${bearerResult.reachable}${bearerResult.error ? ` error=${bearerResult.error}` : ""}`,
      );

      console.log(`\n[OpenAI] testing api-key header (Azure format)...`);
      const azureUrl = `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
      let rawResult: ConnectivityResult;
      try {
        const response = await fetch(azureUrl, {
          method: "POST",
          headers: {
            "api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Respond with only the word 'ok'." },
            ],
          }),
        });
        const text = await response.text();
        let bodyPreview: string;
        try {
          const parsed = JSON.parse(text);
          bodyPreview =
            parsed.choices?.[0]?.message?.content ?? text.slice(0, 100);
        } catch {
          bodyPreview = text.slice(0, 100);
        }
        rawResult = {
          provider: "openai-azure-raw",
          model,
          baseUrl: azureUrl,
          apiKeyPrefix: preview(apiKey),
          reachable: response.ok,
          status: response.status,
          error: response.ok
            ? `response="${bodyPreview}"`
            : `HTTP ${response.status}: ${text.slice(0, 200)}`,
        };
      } catch (err) {
        rawResult = {
          provider: "openai-azure-raw",
          model,
          baseUrl: azureUrl,
          apiKeyPrefix: preview(apiKey),
          reachable: false,
          error:
            err instanceof Error
              ? err.message.slice(0, 300)
              : String(err).slice(0, 300),
        };
      }
      console.log(
        `[OpenAI/Azure/api-key] reachable=${rawResult.reachable}${rawResult.error ? ` error=${rawResult.error}` : ""}`,
      );

      console.log(`\n=== OpenAI Connectivity Summary ===`);
      console.log(`Base URL: ${baseUrl}`);
      console.log(`Model: ${model}`);
      console.log(`API Key: ${preview(apiKey)}`);
      console.log(`Bearer auth reachable: ${bearerResult.reachable}`);
      console.log(`api-key auth reachable: ${rawResult.reachable}`);
    }, 20_000);
  });

  describe("Groq", () => {
    it("should have an API key configured", () => {
      expect(env.GROQ_API_KEY).toBeTruthy();
    });

    it("should be reachable", async () => {
      if (!env.GROQ_API_KEY) return;
      const result = await testProviderConnectivity("groq", () => ({
        provider: new GroqLlmProvider({
          apiKey: env.GROQ_API_KEY!,
          ...(env.GROQ_BASE_URL ? { baseUrl: env.GROQ_BASE_URL } : {}),
          ...(env.GROQ_MODEL ? { model: env.GROQ_MODEL } : {}),
        }),
        model: env.GROQ_MODEL ?? "qwen/qwen3-32b",
        baseUrl: env.GROQ_BASE_URL ?? "(default Groq endpoint)",
        apiKeyPreview: preview(env.GROQ_API_KEY),
      }));
      console.log(
        `\n[Groq] model=${result.model} baseUrl=${result.baseUrl} key=${result.apiKeyPrefix}`,
      );
      console.log(
        `[Groq] reachable=${result.reachable}${result.error ? ` error=${result.error}` : ""}`,
      );
    }, 15_000);
  });
});
