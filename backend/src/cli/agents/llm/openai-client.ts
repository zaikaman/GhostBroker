import {
  LlmProviderError,
  type LlmProvider,
  type LlmProviderErrorKind,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  /**
   * Required OpenAI-compatible base URL. There is no default — callers
   * MUST pass the explicit endpoint for their deployment (e.g. Azure
   * OpenAI at `https://<resource>.openai.azure.com/openai/v1`, OpenAI
   * at `https://api.openai.com/v1`, or a self-hosted reverse proxy).
   * The provider appends `/chat/completions`.
   */
  baseUrl: string;
  /**
   * Override the OpenAI model id. Defaults to `gpt-5-nano`.
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

const DEFAULT_MODEL = "gpt-5-nano";
const DEFAULT_TIMEOUT_MS = 30_000;

interface OpenAIChoice {
  index?: number;
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string | null;
    refusal?: string | null;
    reasoning_content?: string | null;
  };
}

interface OpenAIResponseBody {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: Record<string, unknown>;
  error?: { message?: string; type?: string; code?: string | number };
}

export class OpenAILlmProvider implements LlmProvider {
  public readonly id = "openai";
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LlmProviderError({
        provider: "openai",
        kind: "auth",
        message: "OpenAILlmProvider requires a non-empty apiKey",
      });
    }
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new LlmProviderError({
        provider: "openai",
        kind: "config",
        message:
          "OpenAILlmProvider requires a non-empty baseUrl. " +
          "Set OPENAI_BASE_URL to your OpenAI-compatible endpoint " +
          "(e.g. https://api.openai.com/v1 or your Azure OpenAI deployment).",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = buildOpenAIRequestBody(request, this.model);

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
        message: `OpenAI fetch failed: ${describeError(err)}`,
        cause: err,
      });
    }

    const rawText = await safeReadText(response);
    if (!response.ok) {
      throw classifyHttpError(this.id, response.status, rawText);
    }

    let parsed: OpenAIResponseBody;
    try {
      parsed = JSON.parse(rawText) as OpenAIResponseBody;
    } catch (err) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "shape",
        message: `OpenAI returned non-JSON body: ${truncate(rawText, 200)}`,
        status: response.status,
        cause: err,
      });
    }

    if (parsed.error) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "server",
        message: `OpenAI API error: ${parsed.error.message ?? parsed.error.type ?? "unknown"}`,
        cause: parsed.error,
      });
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "empty",
        message: "OpenAI returned no choices",
        status: response.status,
      });
    }

    const text = (choice.message?.content ?? "").trim();
    const thoughts = (choice.message?.reasoning_content ?? "").trim();
    if (text.length === 0 && thoughts.length === 0) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "empty",
        message: `OpenAI returned empty content (finish_reason=${choice.finish_reason ?? "unknown"})`,
        status: response.status,
      });
    }

    return {
      text,
      thoughts,
      provider: this.id,
      model: parsed.model ?? this.model,
    };
  }
}

function buildOpenAIRequestBody(request: LlmRequest, model: string): Record<string, unknown> {
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
  // max_completion_tokens intentionally omitted — the model
  // determines its output length without artificial limits.
  if (request.includeThoughts === true) {
    body.reasoning_effort = "low";
  }
  return body;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function withTimeout(promise: Promise<Response>, ms: number): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`OpenAI fetch timed out after ${ms}ms`)), ms);
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
  buildOpenAIRequestBody,
  classifyHttpError,
  classifyKindFromStatus,
};
