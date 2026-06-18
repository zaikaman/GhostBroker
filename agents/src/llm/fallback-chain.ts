import {
  LlmProviderError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./types.js";

export type FallbackEventKind = "fallback" | "all_failed";

export interface FallbackEvent {
  kind: FallbackEventKind;
  /** Provider that just failed (and prompted the fallback). */
  from: string;
  /** Provider that will be tried next (or `undefined` if the chain exhausted). */
  to: string | undefined;
  /** The error from `from`. */
  error: LlmProviderError;
  /** Number of providers that still remain to be tried AFTER `to`. */
  remaining: number;
}

export type FallbackListener = (event: FallbackEvent) => void;

export interface FallbackChainOptions {
  providers: LlmProvider[];
  /**
   * Listener invoked whenever the chain falls back from one provider
   * to the next. Used by the agent loop to log `[LLM] primary failed
   * (503), trying openai (1/2)` without throwing on transient errors.
   */
  onFallback?: FallbackListener;
}

/**
 * Iterate a list of providers, falling back on `transient` failures.
 *
 * The chain succeeds on the first provider that returns a response.
 * It fails only when every provider has rejected — and only the
 * `transient` rejections count as a "fall through"; an `auth` /
 * `bad_request` failure is fatal regardless of position, because
 * the same prompt is unlikely to work on a different provider either.
 *
 * The same prompt (including `messages`, `temperature`, etc.) is sent
 * to every provider. There is intentionally no prompt rewriting — the
 * schemas and system prompts are shared across providers.
 */
export class FallbackLlmProvider implements LlmProvider {
  public readonly id: string;
  public readonly model: string;
  private readonly providers: LlmProvider[];
  private readonly onFallback: FallbackListener | undefined;

  public constructor(options: FallbackChainOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("FallbackLlmProvider requires at least one provider");
    }
    this.providers = [...options.providers];
    this.onFallback = options.onFallback;
    this.id = this.providers.map((p) => p.id).join("|");
    this.model = this.providers.map((p) => p.model).join("|");
  }

  public get providerIds(): readonly string[] {
    return this.providers.map((p) => p.id);
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    const errors: LlmProviderError[] = [];

    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index];
      if (!provider) continue;
      try {
        return await provider.complete(request);
      } catch (err) {
        const error = asProviderError(err, provider.id);
        errors.push(error);
        if (!error.transient) {
          throw error;
        }
        const next = this.providers[index + 1];
        if (next !== undefined) {
          this.onFallback?.({
            kind: "fallback",
            from: provider.id,
            to: next.id,
            error,
            remaining: this.providers.length - index - 1,
          });
        }
      }
    }

    const last = errors[errors.length - 1];
    if (!last) {
      throw new Error("FallbackLlmProvider.complete called with empty error list");
    }
    this.onFallback?.({
      kind: "all_failed",
      from: last.provider,
      to: undefined,
      error: last,
      remaining: 0,
    });
    throw new AggregateLlmError(errors);
  }
}

/**
 * Error thrown when every provider in the chain failed. The most
 * recent provider error is kept on `.cause` for compatibility with
 * single-error handlers; the full list of attempts is on `.errors`.
 */
export class AggregateLlmError extends Error {
  public readonly errors: readonly LlmProviderError[];

  public constructor(errors: readonly LlmProviderError[]) {
    const summary = errors
      .map((err) => `${err.provider}:${err.kind}${err.status !== undefined ? `(${err.status})` : ""}`)
      .join(", ");
    super(`All LLM providers failed: ${summary}`);
    this.name = "AggregateLlmError";
    this.errors = errors;
    const last = errors[errors.length - 1];
    if (last !== undefined) {
      (this as Error & { cause?: unknown }).cause = last;
    }
  }
}

function asProviderError(err: unknown, providerId: string): LlmProviderError {
  if (err instanceof LlmProviderError) return err;
  if (err instanceof AggregateLlmError && err.errors.length > 0) {
    const last = err.errors[err.errors.length - 1];
    if (last) return last;
  }
  return new LlmProviderError({
    provider: providerId,
    kind: "unknown",
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}
