export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  /**
   * When true, the provider is asked to surface its internal chain-of-
   * thought. Gemini implements this via `thinkingConfig.includeThoughts`.
   * Other providers ignore the flag (or no-op on the wire).
   */
  includeThoughts?: boolean;
  /**
   * Token budget for the thinking channel. Gemini uses this directly as
   * `thinkingConfig.thinkingBudget`. Other providers ignore it.
   */
  thinkingBudget?: number;
}

export interface LlmResponse {
  /** The final, user-visible text the model produced. */
  text: string;
  /**
   * Optional chain-of-thought text the model exposed via the thinking
   * channel (Gemini `thought` parts). Empty when the provider did not
   * surface thoughts or `includeThoughts` was false.
   */
  thoughts: string;
  /**
   * Provider that produced this response. Useful for telemetry so the
   * agent loop can log which provider served the call after a fallback.
   */
  provider: string;
  /** Opaque model identifier the provider reported in its response. */
  model: string;
}

export type LlmProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "server"
  | "network"
  | "empty"
  | "shape"
  | "config"
  | "unknown";

/**
 * Error thrown by a provider. The `transient` flag is what the fallback
 * chain uses to decide whether to try the next provider: auth and
 * `bad_request` are NOT transient (no point hitting OpenAI if Gemini
 * rejected our prompt); server / rate_limit / network / empty / shape
 * ARE transient (the next provider may succeed). Config errors are
 * NOT transient — retrying with the same options will keep failing
 * until the operator fixes the agent's environment.
 */
export class LlmProviderError extends Error {
  public readonly provider: string;
  public readonly kind: LlmProviderErrorKind;
  public readonly status: number | undefined;
  public readonly transient: boolean;

  public constructor(options: {
    provider: string;
    kind: LlmProviderErrorKind;
    message: string;
    status?: number;
    transient?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmProviderError";
    this.provider = options.provider;
    this.kind = options.kind;
    this.status = options.status;
    this.transient = options.transient ?? defaultTransient(options.kind, options.status);
  }
}

function defaultTransient(kind: LlmProviderErrorKind, status: number | undefined): boolean {
  if (status === 401 || status === 403) return false;
  if (status === 400 || status === 404) return false;
  if (kind === "auth" || kind === "bad_request" || kind === "config") return false;
  return true;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
