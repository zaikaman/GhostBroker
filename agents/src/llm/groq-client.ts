import {
  LlmProviderError,
  type LlmProvider,
  type LlmProviderErrorKind,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

export interface GroqProviderOptions {
  apiKey: string;
  /**
   * Override the Groq API base URL. Defaults to the public Groq
   * Cloud endpoint. Kept as an override so a self-hosted proxy
   * (e.g. on-prem) can be swapped in without code changes.
   */
  baseUrl?: string;
  /**
   * Override the Groq model id. Defaults to `qwen/qwen3-32b`, which
   * is the model the workspace previously used.
   */
  model?: string;
  /**
   * Hard timeout in milliseconds for a single provider call.
   */
  timeoutMs?: number;
  /**
   * Optional `fetch` override — used by tests.
   */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "qwen/qwen3-32b";
const DEFAULT_TIMEOUT_MS = 30_000;

interface GroqChoice {
  index?: number;
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string | null;
  };
}

interface GroqResponseBody {
  id?: string;
  model?: string;
  choices?: GroqChoice[];
  usage?: Record<string, unknown>;
  error?: { message?: string; type?: string; code?: string | number };
}

export class GroqLlmProvider implements LlmProvider {
  public readonly id = "groq";
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: GroqProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LlmProviderError({
        provider: "groq",
        kind: "auth",
        message: "GroqLlmProvider requires a non-empty apiKey",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = buildGroqRequestBody(request, this.model);

    let response: Response;
    try {
      response = await withTimeout(
        this.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        }),
        this.timeoutMs,
      );
    } catch (err) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "network",
        message: `Groq fetch failed: ${describeError(err)}`,
        cause: err,
      });
    }

    const rawText = await safeReadText(response);
    if (!response.ok) {
      throw classifyHttpError(this.id, response.status, rawText);
    }

    let parsed: GroqResponseBody;
    try {
      parsed = JSON.parse(rawText) as GroqResponseBody;
    } catch (err) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "shape",
        message: `Groq returned non-JSON body: ${truncate(rawText, 200)}`,
        status: response.status,
        cause: err,
      });
    }

    if (parsed.error) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "server",
        message: `Groq API error: ${parsed.error.message ?? parsed.error.type ?? "unknown"}`,
        cause: parsed.error,
      });
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "empty",
        message: "Groq returned no choices",
        status: response.status,
      });
    }

    const text = (choice.message?.content ?? "").trim();
    if (text.length === 0) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "empty",
        message: `Groq returned empty content (finish_reason=${choice.finish_reason ?? "unknown"})`,
        status: response.status,
      });
    }

    return {
      text,
      thoughts: "",
      provider: this.id,
      model: parsed.model ?? this.model,
    };
  }
}

function buildGroqRequestBody(request: LlmRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map((msg) => ({ role: msg.role, content: msg.content })),
  };
  if (typeof request.temperature === "number") {
    body.temperature = clamp(request.temperature, 0, 2);
  }
  if (typeof request.topP === "number") {
    body.top_p = clamp(request.topP, 0, 1);
  }
  // max_tokens intentionally omitted — the model determines its
  // output length without artificial limits.
  return body;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function withTimeout(promise: Promise<Response>, ms: number): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Groq fetch timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function classifyHttpError(provider: string, status: number, body: string): LlmProviderError {
  const kind = classifyKindFromStatus(status);
  return new LlmProviderError({
    provider,
    kind,
    status,
    message: `${provider} HTTP ${status}: ${truncate(body, 200)}`,
  });
}

function classifyKindFromStatus(status: number | undefined): LlmProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "server";
  if (status === 400) return "bad_request";
  return "unknown";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\u2026`;
}

export const __testing = {
  buildGroqRequestBody,
  classifyHttpError,
};
