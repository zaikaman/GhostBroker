import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export function loadDotEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(import.meta.dirname, "..", ".env"),
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
      // Standard dotenv semantics: .env fills in missing vars but does
      // NOT override values already set in the environment. This is
      // critical for the hosted agent: when the backend spawns the child
      // process it injects a fresh JWT via process.env (spawn()'s `env`
      // option), and .env must not overwrite that fresh token with a
      // stale file-backed value.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  return value;
}

export function optionalEnvMany(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`Missing or invalid numeric env var: ${name}=${raw}`);
    process.exit(1);
  }
  return parsed;
}

export function numberEnvMany(
  names: readonly string[],
  fallback?: number,
): number | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim().length === 0) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      console.error(`Missing or invalid numeric env var: ${name}=${raw}`);
      process.exit(1);
    }
    return parsed;
  }
  return fallback;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  console.error(`Missing or invalid boolean env var: ${name}=${raw}`);
  process.exit(1);
  return fallback;
}

export const agentEnvSchema = z
  .object({
    GHOSTBROKER_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)),
    GHOSTBROKER_API_KEY: z.string().regex(/^gbk_/u, "must start with the gbk_ prefix").optional(),
    GHOSTBROKER_SESSION_TOKEN: z.string().trim().min(1).optional(),
    GHOSTBROKER_SESSION_EXPIRES_AT: z.string().trim().min(1).optional(),
    GHOSTBROKER_INSTITUTION_ID: z.string().uuid().optional(),
    GHOSTBROKER_INSTITUTION_DISPLAY_NAME: z.string().trim().min(1).optional(),
    GHOSTBROKER_INSTITUTION_TENANT_DID: z.string().trim().min(1).optional(),
    T3N_API_KEY: z.string().min(1).optional(),
    T3N_API_URL: z.string().url().or(z.string().regex(/^https?:\/\//u)).optional(),
    AGENT_IDENTITY_CONFIG_PATH: z.string().min(1).optional(),
    AGENT_IDENTITY_DID: z.string().min(1).optional(),
    DELEGATION_CREDENTIAL_PATH: z.string().min(1).optional(),

    // ── LLM provider chain (Gemini primary, OpenAI fallback, Groq last) ──
    /**
     * Comma-separated provider order. The agent tries each in turn and
     * falls back on transient failures (5xx, 429, network, empty /
     * malformed responses). Auth / 400 errors are fatal — a different
     * provider won't accept a prompt that one rejected. Default:
     * `gemini,openai,groq`.
     */
    LLM_PROVIDER_CHAIN: z.string().trim().min(1).optional(),
    /** Primary provider — Gemini. */
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.1-flash-lite"),
    /**
     * Required when GEMINI_API_KEY is set. The LLM clients no longer
     * ship a default base URL — operators must point at the documented
     * Google endpoint (or their own sanctioned Azure / on-prem proxy)
     * explicitly. Keeping this as `https://...` (not just any string)
     * so a typo like `http//foo` fails fast at startup.
     */
    GEMINI_BASE_URL: z
      .string()
      .url()
      .or(z.string().regex(/^https?:\/\//u))
      .optional(),
    /** Fallback #1 — OpenAI-compatible (Azure OpenAI or OpenAI). */
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-5-nano"),
    /** Required when OPENAI_API_KEY is set. No implicit default. */
    OPENAI_BASE_URL: z
      .string()
      .url()
      .or(z.string().regex(/^https?:\/\//u))
      .optional(),
    /** Fallback #2 — Groq. */
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().trim().min(1).default("qwen/qwen3-32b"),
    /** Required when GROQ_API_KEY is set. No implicit default. */
    GROQ_BASE_URL: z
      .string()
      .url()
      .or(z.string().regex(/^https?:\/\//u))
      .optional(),

    POLL_INTERVAL_MS: z.number().positive().default(5_000),
    AGENT_QUOTE_ASSET_CODE: z.string().trim().min(1).max(32).default("USDC"),
    MAX_TICKS: z.number().positive().default(40),
    DRY_RUN: z.boolean().default(false),

    AGENT_AVAILABLE_QUOTE_BALANCE: z.coerce.number().nonnegative().optional(),
    AGENT_AVAILABLE_BASE_BALANCE: z.coerce.number().nonnegative().optional(),
    HOSTED_AGENT_ID: z.string().uuid().optional(),
    HOSTED_MANDATE_ID: z.string().uuid().optional(),

    /**
     * Institution's tenant signing keypair + derived `did:ethr:`
     * issuer DID. Wired by the backend's `ChildProcessHostedAgentService`
     * at agent spawn time from the `tenant_identities` row. The
     * agent uses these to mint W3C claim VCs the disclosure
     * verifier can hand to `@terminal3/verify_vc` without it
     * throwing "Unsupported DID method: t3n". All three fields
     * are supplied together by the hosted-agent-service; the
     * negotiation loop falls back to the agent's own DID /
     * keypair when the hosted-agent-service did not set them.
     */
    HOSTED_AGENT_TENANT_SIGNER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/u)
      .optional(),
    HOSTED_AGENT_TENANT_SIGNER_PUBLIC_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{66}$/u)
      .optional(),
    HOSTED_AGENT_TENANT_SIGNER_DID: z
      .string()
      .regex(/^did:ethr:0x[0-9a-fA-F]{40}$/u)
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-field: every provider that has a credential must also
    // have an explicit base URL. The LLM clients themselves throw
    // `kind: "config"` if the URL is missing — but failing at env
    // parse time gives a much clearer error than waiting for the
    // first tick to crash deep in the runtime.
    const requireBaseUrl = (
      apiKeyName: "GEMINI_API_KEY" | "OPENAI_API_KEY" | "GROQ_API_KEY",
      baseUrlName: "GEMINI_BASE_URL" | "OPENAI_BASE_URL" | "GROQ_BASE_URL",
      provider: string,
    ): void => {
      if (data[apiKeyName] && !data[baseUrlName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${baseUrlName} is required when ${apiKeyName} is set ` +
            `(no implicit default; point ${provider} at your explicit endpoint, ` +
            `e.g. https://generativelanguage.googleapis.com/v1beta for Gemini).`,
          path: [baseUrlName],
        });
      }
    };
    requireBaseUrl("GEMINI_API_KEY", "GEMINI_BASE_URL", "Gemini");
    requireBaseUrl("OPENAI_API_KEY", "OPENAI_BASE_URL", "OpenAI");
    requireBaseUrl("GROQ_API_KEY", "GROQ_BASE_URL", "Groq");
  });

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function loadAgentEnv(): AgentEnv {
  loadDotEnv();
  const parsed = agentEnvSchema.safeParse({
    GHOSTBROKER_URL: process.env.GHOSTBROKER_URL,
    GHOSTBROKER_API_KEY: process.env.GHOSTBROKER_API_KEY,
    GHOSTBROKER_SESSION_TOKEN: process.env.GHOSTBROKER_SESSION_TOKEN,
    GHOSTBROKER_SESSION_EXPIRES_AT: process.env.GHOSTBROKER_SESSION_EXPIRES_AT,
    GHOSTBROKER_INSTITUTION_ID: process.env.GHOSTBROKER_INSTITUTION_ID,
    GHOSTBROKER_INSTITUTION_DISPLAY_NAME: process.env.GHOSTBROKER_INSTITUTION_DISPLAY_NAME,
    GHOSTBROKER_INSTITUTION_TENANT_DID: process.env.GHOSTBROKER_INSTITUTION_TENANT_DID,
    T3N_API_KEY: process.env.T3N_API_KEY === "" ? undefined : process.env.T3N_API_KEY,
    T3N_API_URL: process.env.T3N_API_URL,
    AGENT_IDENTITY_CONFIG_PATH: process.env.AGENT_IDENTITY_CONFIG_PATH,
    AGENT_IDENTITY_DID: process.env.AGENT_IDENTITY_DID,
    DELEGATION_CREDENTIAL_PATH: process.env.DELEGATION_CREDENTIAL_PATH,
    LLM_PROVIDER_CHAIN: process.env.LLM_PROVIDER_CHAIN,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY === "" ? undefined : process.env.GEMINI_API_KEY,
    GEMINI_MODEL: optionalEnv("GEMINI_MODEL", "gemini-3.1-flash-lite"),
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY === "" ? undefined : process.env.OPENAI_API_KEY,
    OPENAI_MODEL: optionalEnv("OPENAI_MODEL", "gpt-5-nano"),
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GROQ_API_KEY: process.env.GROQ_API_KEY === "" ? undefined : process.env.GROQ_API_KEY,
    GROQ_MODEL: optionalEnv("GROQ_MODEL", "qwen/qwen3-32b"),
    GROQ_BASE_URL: process.env.GROQ_BASE_URL,
    POLL_INTERVAL_MS: numberEnv("POLL_INTERVAL_MS", 5_000),
    AGENT_QUOTE_ASSET_CODE: optionalEnv("AGENT_QUOTE_ASSET_CODE", "USDC"),
    MAX_TICKS: numberEnv("MAX_TICKS", 40),
    DRY_RUN: booleanEnv("DRY_RUN", false),
    AGENT_AVAILABLE_QUOTE_BALANCE: numberEnvMany(
      ["AGENT_AVAILABLE_QUOTE_BALANCE", "AGENT_AVAILABLE_USDC"],
      undefined,
    ),
    AGENT_AVAILABLE_BASE_BALANCE: numberEnvMany(
      ["AGENT_AVAILABLE_BASE_BALANCE", "AGENT_AVAILABLE_WBTC"],
      undefined,
    ),
    HOSTED_AGENT_ID: process.env.HOSTED_AGENT_ID,
    HOSTED_MANDATE_ID: process.env.HOSTED_MANDATE_ID,
    HOSTED_AGENT_TENANT_SIGNER_PRIVATE_KEY:
      process.env.HOSTED_AGENT_TENANT_SIGNER_PRIVATE_KEY,
    HOSTED_AGENT_TENANT_SIGNER_PUBLIC_KEY:
      process.env.HOSTED_AGENT_TENANT_SIGNER_PUBLIC_KEY,
    HOSTED_AGENT_TENANT_SIGNER_DID: process.env.HOSTED_AGENT_TENANT_SIGNER_DID,
  });
  if (!parsed.success) {
    console.error("Invalid environment:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
