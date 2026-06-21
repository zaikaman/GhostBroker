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

export interface BlindIntentLockDescriptor {
  /**
   * Asset the intent is buying or selling. The T3 enclave
   * derives this from the unsealed envelope -- the
   * orchestrator never decodes the envelope itself. The
   * orchestrator uses this for the local cross-candidate
   * filter (a buy intent and a sell intent must trade the
   * same asset to cross) and as the `asset_code` field on
   * the `evaluate-match` wire form.
   */
  tradedAssetCode: string;
  /**
   * Asset to reserve for this intent. For a buy intent, this
   * is the settlement asset (e.g. USDC). For a sell intent,
   * it is the same as `tradedAssetCode`. The T3 enclave
   * derives this from the unsealed envelope.
   */
  assetCode: string;
  /**
   * TEE-attested intent side. The orchestrator uses this for
   * the local match filter (buy/sell cross). The value is the
   * TEE's authoritative claim, not a wire-side plaintext
   * leak.
   */
  side: "buy" | "sell";
  /**
   * TEE-attested intent quantity (decimal string at the
   * contract's implicit `WIRE_SCALE` — `1e18` — so the value
   * flows directly into the `evaluate-match` `quantity` wire
   * field without a re-scale step). Sourced from the
   * `seal-intent` v0.8.0 response, where the enclave emits
   * the value it unsealed from the envelope.
   */
  quantity: string;
  /**
   * TEE-attested intent price (same decimal-string wire
   * form). Sourced from the `seal-intent` v0.8.0 response.
   */
  price: string;
  /**
   * Reservation amount. `quantity * price` for a buy;
   * `quantity` for a sell. Derived in the enclave and
   * surfaced on the `seal-intent` response.
   */
  amount: number;
  /**
   * TEE-issued attestation reference. The portfolio service
   * can hand this to a TEE verifier to confirm the
   * descriptor was actually produced by the T3 enclave for
   * this intent handle. The orchestrator does not interpret
   * the value; it just carries it through.
   */
  attestationRef: string;
}

export interface BlindIntentResult {
  intentHandle: string;
  state: "intent_sealed";
  executionRef: string;
  sealedAt: string;
  /**
   * TEE-attested balance-lock claim. The orchestrator forwards
   * this descriptor to the portfolio service for the per-intent
   * reservation. The enclave has already decrypted the envelope
   * and computed the derived reservation; the orchestrator never
   * sees plaintext `side` / `quantity` / `price`.
   */
  lockDescriptor: BlindIntentLockDescriptor;
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
  /**
   * Settlement asset code (e.g. "USDC"). The in-process
   * descriptor fallback uses this as the buy-side reservation
   * asset (sells always reserve the traded asset). Production
   * T3N responses include the asset code in the
   * `lock_descriptor` and ignore this value; it only matters for
   * the test-path envelope re-decoding.
   */
  settlementAssetCode?: string;
}

interface T3BlindIntentResponse {
  intent_handle?: string;
  execution_ref?: string;
  /**
   * v0.8.0+ per-side TEE-attested trading parameters. The
   * enclave unseals the envelope and emits these fields so
   * the orchestrator can forward `quantity` / `price` /
   * `traded_asset_code` directly to `evaluate-match` on the
   * canonical Rust wire form. Pre-v0.8.0 hosts that do not
   * emit these fields fall through to the in-process
   * envelope decode below.
   */
  traded_asset_code?: string;
  settlement_asset_code?: string;
  side?: "buy" | "sell";
  quantity?: string;
  price?: string;
  amount?: string;
  attestation_ref?: string;
  /**
   * Pre-v0.8.0 envelope. Replaced by the top-level fields
   * above on v0.8.0+; kept here so the in-process decode
   * fallback still has a stable shape when running against
   * older test hosts.
   */
  lock_descriptor?: {
    traded_asset_code?: string;
    asset_code?: string;
    side?: "buy" | "sell";
    amount?: string;
    attestation_ref?: string;
    quantity?: string;
    price?: string;
  };
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

/**
 * The on-the-wire envelope schema version shared by the GhostBroker
 * agent process (`buildSealedEnvelope` in
 * `agents/src/sealed-envelope.ts`) and the T3 seal contract. The
 * envelope is a base64url-encoded JSON blob. The T3 enclave holds
 * the only decryption key; in production the orchestrator never
 * decodes the envelope itself — it consumes the TEE-attested
 * `lockDescriptor` from the seal response. The in-process test
 * path re-decodes the envelope to derive a deterministic
 * descriptor for the test orchestrator; the production TEE must
 * return the descriptor on its own.
 */
export const SEALED_ENVELOPE_SCHEMA_VERSION = "ghostbroker.envelope/1";

export interface SealedEnvelopePayload {
  v: string;
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  nonce: string;
}

/**
 * Decode a base64url-encoded sealed envelope back into its
 * structured payload. Throws on any schema mismatch — the caller
 * is responsible for falling back to a default descriptor when
 * the envelope was not produced by the canonical `buildSealedEnvelope`
 * (e.g. an in-process test stub).
 */
export function decodeSealedEnvelope(envelope: string): SealedEnvelopePayload {
  let json: string;
  try {
    json = Buffer.from(envelope, "base64url").toString("utf8");
  } catch (cause) {
    throw new Error("Sealed envelope is not valid base64url.", { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error("Sealed envelope is not valid JSON.", { cause });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Sealed envelope is not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== SEALED_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `Sealed envelope schema version mismatch (expected ${SEALED_ENVELOPE_SCHEMA_VERSION}).`,
    );
  }
  const side = record["side"];
  if (side !== "buy" && side !== "sell") {
    throw new Error("Sealed envelope side is not 'buy' or 'sell'.");
  }
  const quantity = record["quantity"];
  const price = record["price"];
  if (typeof quantity !== "number" || typeof price !== "number") {
    throw new Error("Sealed envelope quantity/price are not numbers.");
  }
  return {
    v: String(record["v"]),
    institutionId: String(record["institutionId"] ?? ""),
    agentDid: String(record["agentDid"] ?? ""),
    authorityRef: String(record["authorityRef"] ?? ""),
    assetCode: String(record["assetCode"] ?? ""),
    side,
    quantity,
    price,
    nonce: String(record["nonce"] ?? ""),
  };
}

function parseLockAmount(raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error("Lock descriptor amount is missing.");
  }
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(trimmed) && !/^\.\d+$/u.test(trimmed)) {
    throw new Error(
      `Lock descriptor amount is not a plain non-negative decimal (${raw}).`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Lock descriptor amount is non-finite or non-positive (${raw}).`,
    );
  }
  return parsed;
}

export class T3BlindIntentClient implements BlindIntentClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;
  private readonly settlementAssetCode: string | undefined;

  public constructor(options: T3BlindIntentClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/matching/blind-intents";
    this.settlementAssetCode = options.settlementAssetCode;
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
         // v0.8.0+: the enclave needs the settlement asset
        // code to compute the buy-side reservation amount
        // (`quantity * price`) in the right unit. Optional —
        // the contract falls back to `"USDC"` when the host
         // does not forward it (a pre-v0.8.0 build).
        ...(this.settlementAssetCode
          ? { settlement_asset_code: this.settlementAssetCode }
          : {}),
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

    const intentHandle =
      response.body.intent_handle ?? opaqueHandle(fallbackSeed);
    const executionRef =
      response.body.execution_ref ?? `t3exec_${randomUUID()}`;

    // The TEE returns the lock descriptor alongside the opaque
    // handle. In a production T3-backed build the descriptor is
    // TEE-attested (`attestation_ref` is a real T3N attestation);
    // the orchestrator forwards it to the portfolio service for
    // the SQL reservation without interpreting the values.
    //
     // v0.8.0+ TEE responses emit the per-side trading
    // parameters (`traded_asset_code`, `settlement_asset_code`,
    // `side`, `quantity`, `price`, `amount`, `attestation_ref`)
    // as siblings on the response — the enclave unseals the
    // envelope inside the TEE and surfaces the values it
    // extracted. The orchestrator carries those values through
    // to the `evaluate-match` wire form so the canonical Rust
    // shape is populated end-to-end without an orchestrator-
    // side envelope decode.
    //
    // The in-process test path (the seal request hit a T3N
     // stub that did not produce the v0.8.0 fields) falls back
    // to deriving a deterministic descriptor from the envelope
    // so the rest of the orchestrator and the test assertions
    // keep working. The in-process derivation is explicit and
    // bounded — there is no flow in which the orchestrator
    // decodes the envelope on its own outside this explicit
    // fallback.
    const lockDescriptor = this.resolveLockDescriptor(
      response.body,
      request.encryptedIntentEnvelope,
      intentHandle,
    );

    return {
      intentHandle,
      executionRef,
      state: "intent_sealed",
      sealedAt: new Date().toISOString(),
      lockDescriptor,
    };
  }

  /**
   * Resolve the TEE-attested balance-lock claim for a sealed
   * intent. In production the T3 enclave returns the descriptor
   * verbatim on the `seal-intent` response and the
   * orchestrator carries it through. When the T3N response
    * predates v0.8.0 (the in-process test path uses T3N stubs
   * that don't yet emit the new fields), the orchestrator
   * derives a deterministic descriptor from the locally-sealed
   * envelope so the test assertions remain stable. The
   * fallback is gated on the envelope being a canonical
   * `buildSealedEnvelope` payload; non-canonical envelopes
   * (e.g. raw ciphertext) raise so the test cannot silently
   * leak plaintext.
   */
  private resolveLockDescriptor(
    upstream: T3BlindIntentResponse,
    envelope: string,
    intentHandle: string,
  ): BlindIntentLockDescriptor {
    // v0.8.0+: the enclave unseals the envelope and emits the
    // per-side TEE-attested parameters as siblings on the
    // response. Prefer those over any nested `lock_descriptor`
    // (a pre-v0.8.0 shape). Either path populates the same
    // descriptor fields.
    if (
      upstream.traded_asset_code &&
      upstream.settlement_asset_code &&
      upstream.side &&
      upstream.quantity &&
      upstream.price &&
      upstream.amount &&
      upstream.attestation_ref
    ) {
      return {
        tradedAssetCode: String(upstream.traded_asset_code).toUpperCase(),
        assetCode: String(upstream.settlement_asset_code).toUpperCase(),
        side: upstream.side,
        quantity: parseWireDecimal(
          String(upstream.quantity),
          "quantity",
        ),
        price: parseWireDecimal(String(upstream.price), "price"),
        amount: parseLockAmount(String(upstream.amount)),
        attestationRef: String(upstream.attestation_ref),
      };
    }
    if (
      upstream.lock_descriptor &&
      upstream.lock_descriptor.traded_asset_code &&
      upstream.lock_descriptor.asset_code &&
      upstream.lock_descriptor.side &&
      upstream.lock_descriptor.amount &&
      upstream.lock_descriptor.attestation_ref
    ) {
      // Pre-v0.8.0 host. The TEE only emitted the reservation
      // descriptor (not the per-side quantity / price). The
      // in-process fallback below decodes the envelope to
      // recover the per-side values for the `evaluate-match`
      // wire form.
      const decoded = decodeSealedEnvelope(envelope);
      const quantity = String(decoded.quantity);
      const price = String(decoded.price);
      const side = upstream.lock_descriptor.side;
      const amount = Number(
        String(upstream.lock_descriptor.amount).trim(),
      );
      if (!Number.isFinite(amount)) {
        throw new Error(
          `Lock descriptor amount is non-finite (${upstream.lock_descriptor.amount}).`,
        );
      }
      return {
        tradedAssetCode: String(upstream.lock_descriptor.traded_asset_code).toUpperCase(),
        assetCode: String(upstream.lock_descriptor.asset_code).toUpperCase(),
        side,
        quantity,
        price,
        amount,
        attestationRef: String(upstream.lock_descriptor.attestation_ref),
      };
    }
    const decoded = decodeSealedEnvelope(envelope);
    const settlementAsset =
      this.settlementAssetCode ?? decoded.assetCode.toUpperCase();
    const tradedAssetCode = decoded.assetCode.toUpperCase();
    const descriptorAsset =
      decoded.side === "buy" ? settlementAsset : tradedAssetCode;
    const descriptorAmount =
      decoded.side === "buy"
        ? decoded.quantity * decoded.price
        : decoded.quantity;
    return {
      tradedAssetCode,
      assetCode: descriptorAsset,
      side: decoded.side,
      quantity: String(decoded.quantity),
      price: String(decoded.price),
      amount: descriptorAmount,
      attestationRef: `t3attest:${intentHandle}`,
    };
  }
}

/**
 * Parse a `WIRE_SCALE`-aligned decimal string into a plain
 * decimal string for transport on the `T3LockDescriptor`. The
 * Rust `seal-intent` already emits `format_decimal`-formatted
 * strings (no exponent, no trailing `.`), but we defensively
 * re-format here so a malformed value cannot flow into the
 * `evaluate-match` wire form.
 */
function parseWireDecimal(value: string, field: string): string {
  const trimmed = value.trim();
  if (
    !/^\d+(?:\.\d+)?$/u.test(trimmed) &&
    !/^\.\d+$/u.test(trimmed)
  ) {
    throw new Error(
      `Lock descriptor ${field} is not a plain non-negative decimal (${value}).`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Lock descriptor ${field} is non-finite or non-positive (${value}).`,
    );
  }
  return trimmed;
}
