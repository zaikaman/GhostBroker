import { createHash, randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface BlindIntentRequest {
  institutionId: string;
  agentDid: string;
  encryptedIntentEnvelope: string;
  authorityRef: string;
  correlationRef: string;
}

export interface BlindIntentResult {
  intentHandle: string;
  state: "intent_sealed";
  executionRef: string;
  sealedAt: string;
}

export interface BlindIntentClient {
  sealIntent(request: BlindIntentRequest): Promise<BlindIntentResult>;
}

export interface T3BlindIntentClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  contractPath?: string;
}

interface T3BlindIntentResponse {
  intent_handle?: string;
  execution_ref?: string;
}

/**
 * T3N network responses the blind-intent seal path can produce. We
 * keep the fields loose (`unknown`) because the testnet and any
 * future production endpoint can shape the body however the T3
 * operators want; we only consume `code` + `detail` to classify
 * the failure into one of the {@link BlindIntentSealFailureKind}
 * categories below.
 */
interface T3BlindIntentErrorBody {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  status?: unknown;
  request_id?: unknown;
}

export type BlindIntentSealFailureKind =
  /** T3N has no `matching` contract registered for this tenant DID. */
  | "contract_not_registered"
  /** T3N rejected the request for some other reason (auth, schema, quota). */
  | "t3_request_failed"
  /** Network/transport failure or unparseable T3 response. */
  | "t3_unreachable";

/**
 * Thrown by {@link T3BlindIntentClient.sealIntent} when the T3N
 * network refuses to seal the intent. Carries the classified
 * failure {@link kind} plus the raw upstream body so the caller
 * (the GhostBroker orchestrator route) can surface a useful
 * error to the agent instead of a generic "submission failed".
 *
 * Why a typed error and not the previous `Error("T3 hidden intent
 * sealing failed.")`:
 *   - The previous generic 400 hid the real cause. The agent log
 *     showed `400 validation_failed: The request could not be
 *     accepted.` with no signal that the T3N `matching`
 *     contract was missing. Operators had to scrape the backend
 *     stderr to diagnose it.
 *   - The new error lets the route map `contract_not_registered`
 *     to a 503 with a real message ("T3N tenant contract
 *     'matching' is not registered") and let `t3_request_failed`
 *     and `t3_unreachable` pass through with their upstream
 *     body attached as the cause.
 */
export class BlindIntentSealFailureError extends Error {
  public readonly kind: BlindIntentSealFailureKind;
  public readonly status: number;
  public readonly upstreamBody: unknown;

  public constructor(input: {
    kind: BlindIntentSealFailureKind;
    status: number;
    upstreamBody: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "BlindIntentSealFailureError";
    this.kind = input.kind;
    this.status = input.status;
    this.upstreamBody = input.upstreamBody;
  }
}

/**
 * Classify a non-2xx T3N response into a {@link BlindIntentSealFailureKind}
 * + human-readable message. Exported for tests so we can lock the
 * classification rules down; production callers should not need to
 * invoke this directly.
 */
export function classifyBlindIntentSealFailure(
  status: number,
  rawBody: unknown,
): { kind: BlindIntentSealFailureKind; message: string } {
  const body = (rawBody ?? {}) as T3BlindIntentErrorBody;
  const code = typeof body.code === "string" ? body.code : "";
  const detail = typeof body.detail === "string" ? body.detail : "";
  const message = typeof body.message === "string" ? body.message : "";

  // The T3N testnet reports an un-registered tenant contract as
  // HTTP 404 with body `{ code: "not_found", detail: "tenant
  // contract <did>:<contract> not registered" }`. Production
  // proxies in front of T3N sometimes re-shape the same
  // condition as a 503 with `code: "t3_sdk_request_failed"` —
  // accept both so the orchestrator route can rely on a single
  // classification.
  const isNotRegistered =
    code === "not_found" ||
    code === "t3_sdk_request_failed" ||
    detail.includes("not registered") ||
    message.includes("not registered");

  if (isNotRegistered) {
    // Try to extract the contract name from the detail string
    // for the message ("tenant contract <did>:matching not
    // registered" → "matching"). Fall back to the static label
    // if the shape ever changes.
    const contractMatch = /:([a-z0-9_-]+)\s+not registered/i.exec(detail);
    const contractName = contractMatch?.[1] ?? "matching";
    return {
      kind: "contract_not_registered",
      message: `T3N tenant contract '${contractName}' is not registered for this tenant. ` +
        "Register the matching contract on T3N, or run the T3 onboarding flow that provisions it automatically.",
    };
  }

  return {
    kind: "t3_request_failed",
    message:
      message ||
      detail ||
      `T3N rejected the blind-intent seal request (HTTP ${status}).`,
  };
}

function opaqueHandle(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `intent_${digest.slice(0, 32)}`;
}

export class T3BlindIntentClient implements BlindIntentClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;

  public constructor(options: T3BlindIntentClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/matching/blind-intents";
  }

  public async sealIntent(request: BlindIntentRequest): Promise<BlindIntentResult> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3BlindIntentResponse>({
      method: "POST",
      path: this.contractPath,
      body: {
        // The TEE contract's `SealIntentInput` deserializer
        // (contracts/matching-policy/src/lib.rs) expects
        // snake_case keys — `institution_id`, `agent_did`,
        // `encrypted_intent`. The public `BlindIntentRequest`
        // interface is camelCase to match the rest of the
        // GhostBroker API surface, so we translate at the
        // network boundary. Posting the camelCase form
        // produces the T3N 400
        //   `seal-intent: invalid JSON input: missing field
        //    'institution_id' at line 1 column <N>`
        // because the host's `generic-input` envelope hands
        // the contract the camelCase JSON and the contract
        // can't find the field it expects.
        institution_id: request.institutionId,
        agent_did: request.agentDid,
        encrypted_intent: request.encryptedIntentEnvelope,
        authority_ref: request.authorityRef,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      const { kind, message } = classifyBlindIntentSealFailure(
        response.status,
        response.body,
      );
      throw new BlindIntentSealFailureError({
        kind,
        status: response.status,
        upstreamBody: response.body,
        message,
      });
    }

    const fallbackSeed = [
      request.institutionId,
      request.agentDid,
      request.authorityRef,
      request.correlationRef,
      randomUUID(),
    ].join(":");

    return {
      intentHandle: response.body.intent_handle ?? opaqueHandle(fallbackSeed),
      executionRef: response.body.execution_ref ?? `t3exec_${randomUUID()}`,
      state: "intent_sealed",
      sealedAt: new Date().toISOString(),
    };
  }
}
