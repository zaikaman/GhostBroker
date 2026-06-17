import {
  T3nClient,
  TenantClient,
  createEthAuthInput,
  eth_get_address,
  getNodeUrl,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
  setNodeUrl,
  type Environment,
  type TenantMeResponse,
} from "@terminal3/t3n-sdk";

export interface T3NetworkRequest {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface T3NetworkResponse<TBody = unknown> {
  status: number;
  body: TBody;
}

export interface T3NetworkClient {
  request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>>;
}

export interface T3AdkTransport {
  request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>>;
}

export interface AuthenticatedT3NetworkClientOptions {
  apiKey: string;
  environment: Environment;
  networkUrl?: string;
  expectedTenantDid?: string;
}

function ensureDid(value: string | undefined): string {
  if (!value || !value.startsWith("did:t3n:")) {
    throw new Error("Terminal 3 authentication did not return a valid T3N DID.");
  }

  return value;
}

function normalizeUnknownBody(value: unknown): unknown {
  if (value && typeof value === "object" && "tenant" in value) {
    return value;
  }

  return value;
}

export class SdkAuthenticatedT3NetworkClient implements T3NetworkClient {
  private readonly t3n: T3nClient;
  private readonly tenant: TenantClient;
  private readonly tenantDid: string;

  public constructor(t3n: T3nClient, tenant: TenantClient, tenantDid: string) {
    this.t3n = t3n;
    this.tenant = tenant;
    this.tenantDid = tenantDid;
  }

  /**
   * The authenticated tenant DID returned by the T3N
   * handshake. The backend uses this as the `issuer` of
   * every server-minted delegation VC, and as the
   * `subject` of the tenant identity record on disk. Read
   * once at backend boot and reused for the lifetime of
   * the process.
   */
  public get tenantDidValue(): string {
    return this.tenantDid;
  }

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    try {
      if (request.path === "/tenant/session/resolve") {
        return {
          status: 200,
          body: { tenantDid: this.tenantDid } as TBody,
        };
      }

      if (request.path === "/tenant/register") {
        await this.tenant.tenant.claim();
        const tenant = normalizeUnknownBody(await this.tenant.tenant.me()) as
          | TenantMeResponse
          | undefined;

        return {
          status: 200,
          body: {
            tenantDid:
              typeof tenant?.tenant === "string" ? tenant.tenant : this.tenantDid,
          } as TBody,
        };
      }

      if (request.path === "/tokens/balance") {
        const usage = await this.t3n.getUsage?.({ limit: 1 });

        return {
          status: 200,
          body: {
            account: this.tenantDid,
            available: String(usage?.balance.available ?? 0),
          } as TBody,
        };
      }

      if (request.path === "/tenant/maps" && request.method === "POST") {
        const result = await this.provisionTenantMap(request.body);
        return {
          status: 200,
          body: result as TBody,
        };
      }

      const contractRoute = matchContractRoute(request.path);
      if (contractRoute && request.method === "POST") {
        const result = await this.tenant.contracts.execute(contractRoute.tail, {
          version: readVersionFromBody(request.body),
          functionName: contractRoute.functionName,
          input: extractContractInput(request.body),
        });
        return {
          status: 200,
          body: result as TBody,
        };
      }

      const runnerRoute = matchRunnerRoute(request.path);
      if (runnerRoute && request.method === "POST") {
        // The T3N SDK does not expose a first-class runner session
        // lifecycle API; these routes are emitted by GhostBroker's
        // own runner and are intentionally routed through the tenant
        // control payload. Failures here are operator-actionable, not
        // authority or trust decisions.
        const result = await this.tenant.controlPayload(
          runnerRoute.functionName,
          request.body ?? {},
        );
        return {
          status: 200,
          body: result as TBody,
        };
      }

      return {
        status: 503,
        body: {
          code: "unsupported_t3_sdk_operation",
          path: request.path,
        } as TBody,
      };
    } catch (error) {
      console.error("[T3N CLIENT REQUEST ERROR]", error);
      return {
        status: 503,
        body: {
          code: classifySdkError(error),
          message: error instanceof Error ? error.message : "Terminal 3 request failed.",
        } as TBody,
      };
    }
  }

  /**
   * Translate GhostBroker's `{tail, readers: string[], writers: string[]}`
   * sealed-secret-map shape into the SDK's `MapCreateInput`. The SDK's
   * `WriterSet` / `ReaderSet` accept either the literal `"all"` (every
   * tenant contract may read/write) or a numeric `{ only: number[] }`
   * list of contract ids. GhostBroker's `SealedSecretMapProvisioner`
   * passes string tails (matching the Ghostbroker delegation BUIDL convention),
   * so when no numeric id is known we use `"All"` and surface that
   * the host will resolve it. When at least one numeric contract id
   * is supplied (the Ghostbroker delegation demo's `0` default for a freshly
   * published contract), we use `{ Only: number[] }`.
   */
  private async provisionTenantMap(body: unknown): Promise<unknown> {
    const request = body as {
      tail?: string;
      visibility?: string;
      writers?: readonly string[];
      readers?: readonly string[];
      acl?: { readers?: readonly string[]; writers?: readonly string[] };
    } | undefined;

    const tail = request?.tail;
    if (typeof tail !== "string" || tail.length === 0) {
      const error = new Error("tenant/maps request missing map tail.");
      error.name = "TenantSdkValidationError";
      throw error;
    }

    const writerIds = toContractIds(request?.writers ?? request?.acl?.writers);
    const readerIds = toContractIds(request?.readers ?? request?.acl?.readers);

    return this.tenant.maps.create({
      tail,
      visibility: request?.visibility ?? "private",
      writers: writerIds.length > 0 ? { Only: writerIds } : "All",
      ...(readerIds.length > 0 ? { readers: { Only: readerIds } } : {}),
    });
  }
}

export async function createAuthenticatedT3NetworkClient(
  options: AuthenticatedT3NetworkClientOptions,
): Promise<SdkAuthenticatedT3NetworkClient> {
  setEnvironment(options.environment);

  if (options.networkUrl) {
    setNodeUrl(options.networkUrl);
  }

  const baseUrl = getNodeUrl(options.networkUrl);
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(options.apiKey);
  const t3n = new T3nClient({
    baseUrl,
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, options.apiKey),
    },
  });

  await t3n.handshake();
  const authenticatedDid = ensureDid(
    (await t3n.authenticate(createEthAuthInput(address))).value,
  );

  if (
    options.expectedTenantDid &&
    options.expectedTenantDid !== authenticatedDid
  ) {
    throw new Error("Terminal 3 authenticated DID did not match T3_TENANT_DID.");
  }

  const tenant = new TenantClient({
    environment: options.environment,
    endpoint: baseUrl,
    baseUrl,
    tenantDid: authenticatedDid,
    t3n,
  });

  return new SdkAuthenticatedT3NetworkClient(t3n, tenant, authenticatedDid);
}

export interface FetchT3NetworkClientOptions {
  networkUrl: string;
  tenantDid: string;
  walletPrivateKeyRef: string;
  fetchImpl?: typeof fetch;
}

export class FetchT3NetworkClient implements T3NetworkClient {
  private readonly baseUrl: URL;
  private readonly tenantDid: string;
  private readonly walletPrivateKeyRef: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: FetchT3NetworkClientOptions) {
    this.baseUrl = new URL(options.networkUrl);
    this.tenantDid = options.tenantDid;
    this.walletPrivateKeyRef = options.walletPrivateKeyRef;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    const url = new URL(request.path, this.baseUrl);
    const init: RequestInit = {
      method: request.method,
      headers: {
        "content-type": "application/json",
        "x-t3-tenant-did": this.tenantDid,
        "x-t3-wallet-key-ref": this.walletPrivateKeyRef,
        ...request.headers,
      },
    };

    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }

    const response = await this.fetchImpl(url, init);

    const text = await response.text();
    const body = text.length > 0 ? (JSON.parse(text) as TBody) : (undefined as TBody);

    return {
      status: response.status,
      body,
    };
  }
}

export class AdkBackedT3NetworkClient implements T3NetworkClient {
  private readonly transport: T3AdkTransport;

  public constructor(transport: T3AdkTransport) {
    this.transport = transport;
  }

  public request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    return this.transport.request<TBody>(request);
  }
}

/**
 * Map the legacy `T3NetworkClient` path strings emitted by
 * GhostBroker's enclave consumers onto the tenant SDK's contract
 * execution surface. Returns `null` when the path is not a
 * contract execution. Only POST is supported — the SDK's
 * `tenant.contracts.execute` is the only read-or-write entry
 * point the tenant namespace exposes.
 */
function matchContractRoute(
  path: string,
): { tail: string; functionName: string } | null {
  if (path === "/contracts/matching/blind-intents") {
    return { tail: "matching", functionName: "seal-intent" };
  }
  if (path === "/contracts/matching/evaluate") {
    return { tail: "matching", functionName: "evaluate-match" };
  }
  if (path === "/contracts/negotiation/tickets") {
    return { tail: "matching", functionName: "seal-ticket" };
  }
  return null;
}

/**
 * Map runner session lifecycle paths onto tenant control payload
 * function names. The T3N SDK does not expose a first-class
 * runner session API; these routes describe enclave-internal
 * state and are routed through `tenant.controlPayload(...)` so
 * the call still flows through the authenticated session.
 */
function matchRunnerRoute(
  path: string,
): { functionName: string } | null {
  if (path === "/runner/session") {
    return { functionName: "runner.session.open" };
  }
  if (path === "/runner/session/close") {
    return { functionName: "runner.session.close" };
  }
  return null;
}

/**
 * Best-effort contract-id extractor for the SDK's `WriterSet` /
 * `ReaderSet` shape. Strings that parse as non-negative integers
 * become numeric ids; anything else is dropped with a debug log
 * so the caller doesn't silently lose ACL entries. The host's
 * `z:<tenant>:<tail>` namespace resolves the string form during
 * ACL evaluation either way.
 */
function toContractIds(values: readonly string[] | undefined): number[] {
  if (!values) {
    return [];
  }
  const ids: number[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    if (/^\d+$/u.test(value)) {
      ids.push(Number(value));
    }
  }
  return ids;
}

/**
 * Extract the contract version from a request body. The enclave
 * consumers pass it as a sibling of the input payload (see
 * `T3MatchContractClient`'s `contractVersion` option pattern);
 * this helper tolerates either the sibling shape or a flat
 * `{version, input}` shape so a future refactor doesn't break
 * the adapter.
 */
function readVersionFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "0.1.0";
  }
  const record = body as Record<string, unknown>;
  if (typeof record.version === "string") {
    return record.version;
  }
  if (typeof record.contractVersion === "string") {
    return record.contractVersion;
  }
  return "0.1.0";
}

/**
 * Extract the contract function input from a request body. When
 * the body already carries an `input` field (the existing match
 * and blind-intent consumers do), pass it through. Otherwise, the
 * whole body is treated as the input — that matches the
 * Ghostbroker delegation BUIDL's `client.contracts.execute(tail, {input})`
 * convention.
 */
function extractContractInput(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body ?? {};
  }
  const record = body as Record<string, unknown>;
  if ("input" in record) {
    return record.input;
  }
  const { version: _version, contractVersion: _contractVersion, ...rest } = record;
  return rest;
}

/**
 * Map an SDK throwable onto a stable string code so consumers
 * can branch on `response.body.code` without parsing the message.
 * The class names are imported via the SDK's public surface but
 * we only string-match on `error.name` to keep this adapter
 * resilient to SDK version bumps that may rename internals.
 */
function classifySdkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TenantSdkValidationError") {
      return "t3_sdk_validation_error";
    }
    if (error.name === "UnsupportedTenantSdkOperationError") {
      return "unsupported_t3_sdk_operation";
    }
    if (error.name === "RpcError") {
      return "t3_rpc_error";
    }
    if (error.name === "AuthenticationError" || error.name === "SessionExpiredError") {
      return "t3_auth_error";
    }
  }
  return "t3_sdk_request_failed";
}
