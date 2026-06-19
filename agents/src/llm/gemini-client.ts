import {
  LlmProviderError,
  type LlmProvider,
  type LlmProviderErrorKind,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  /**
   * Override the Gemini API base URL. Defaults to the v98store
   * proxy documented for the demo (`v1beta` root). The provider
   * appends `/models/{model}:generateContent`.
   */
  baseUrl?: string;
  /**
   * Override the Gemini model id. Defaults to `gemini-3.1-flash-lite`,
   * which is the workspace's primary model.
   */
  model?: string;
  /**
   * Hard timeout in milliseconds for a single provider call. Defaults
   * to 30s, which is well over the typical Gemini flash response time
   * but short enough to avoid a single slow provider stalling the
   * agent's tick budget.
   */
  timeoutMs?: number;
  /**
   * Optional `fetch` override — used by tests to stub responses without
   * patching the global. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://v98store.com/v1beta";
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_TIMEOUT_MS = 30_000;

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
    role?: string;
  };
  finishReason?: string;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  modelVersion?: string;
  usageMetadata?: Record<string, unknown>;
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiLlmProvider implements LlmProvider {
  public readonly id = "gemini";
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: GeminiProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LlmProviderError({
        provider: "gemini",
        kind: "auth",
        message: "GeminiLlmProvider requires a non-empty apiKey",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = buildGeminiRequestBody(request);

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
        message: `Gemini fetch failed: ${describeError(err)}`,
        cause: err,
      });
    }

    const rawText = await safeReadText(response);
    if (!response.ok) {
      throw classifyHttpError(this.id, response.status, rawText);
    }

    let parsed: GeminiResponseBody;
    try {
      parsed = JSON.parse(rawText) as GeminiResponseBody;
    } catch (err) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "shape",
        message: `Gemini returned non-JSON body: ${truncate(rawText, 200)}`,
        status: response.status,
        cause: err,
      });
    }

    if (parsed.error) {
      throw new LlmProviderError({
        provider: this.id,
        kind: classifyKindFromStatus(undefined, parsed.error.status),
        message: `Gemini API error: ${parsed.error.message ?? parsed.error.status ?? "unknown"}`,
        cause: parsed.error,
      });
    }

    const candidate = parsed.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "empty",
        message: `Gemini returned no content parts (finishReason=${candidate?.finishReason ?? "unknown"})`,
        status: response.status,
      });
    }

    const visibleParts: string[] = [];
    const thoughtParts: string[] = [];
    for (const part of parts) {
      if (typeof part.text !== "string" || part.text.length === 0) continue;
      if (part.thought === true) {
        thoughtParts.push(part.text);
      } else {
        visibleParts.push(part.text);
      }
    }

    if (visibleParts.length === 0 && thoughtParts.length === 0) {
      throw new LlmProviderError({
        provider: this.id,
        kind: "empty",
        message: "Gemini response had no text content",
        status: response.status,
      });
    }

    return {
      text: visibleParts.join("\n").trim(),
      thoughts: thoughtParts.join("\n").trim(),
      provider: this.id,
      model: parsed.modelVersion ?? this.model,
    };
  }
}

function buildGeminiRequestBody(request: LlmRequest): Record<string, unknown> {
  const systemMessages = request.messages.filter((msg) => msg.role === "system");
  const conversationMessages = request.messages.filter((msg) => msg.role !== "system");

  const systemInstruction =
    systemMessages.length > 0
      ? {
          parts: systemMessages.map((msg) => ({ text: msg.content })),
        }
      : undefined;

  const contents = conversationMessages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  const generationConfig: Record<string, unknown> = {};
  if (typeof request.temperature === "number") {
    generationConfig.temperature = clamp(request.temperature, 0, 2);
  }
  if (typeof request.topP === "number") {
    generationConfig.topP = clamp(request.topP, 0, 1);
  }
  // maxOutputTokens intentionally omitted — the model determines
  // its output length without artificial limits.

  if (request.includeThoughts === true || typeof request.thinkingBudget === "number") {
    const thinkingConfig: Record<string, unknown> = {
      includeThoughts: request.includeThoughts === true,
    };
    if (typeof request.thinkingBudget === "number") {
      thinkingConfig.thinkingBudget = Math.max(0, Math.floor(request.thinkingBudget));
    }
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const body: Record<string, unknown> = { contents };
  if (systemInstruction !== undefined) {
    body.systemInstruction = systemInstruction;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
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
    timer = setTimeout(() => reject(new Error(`Gemini fetch timed out after ${ms}ms`)), ms);
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
  const kind = classifyKindFromStatus(status, undefined);
  return new LlmProviderError({
    provider,
    kind,
    status,
    message: `${provider} HTTP ${status}: ${truncate(body, 200)}`,
  });
}

function classifyKindFromStatus(
  status: number | undefined,
  statusText: string | undefined,
): LlmProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "server";
  if (status === 400) return "bad_request";
  if (statusText && /UNAVAILABLE|RESOURCE_EXHAUSTED|OVERLOADED/u.test(statusText)) {
    return "rate_limit";
  }
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
  buildGeminiRequestBody,
  classifyHttpError,
  classifyKindFromStatus,
};
