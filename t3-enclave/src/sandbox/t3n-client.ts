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

      return {
        status: 503,
        body: {
          code: "unsupported_t3_sdk_operation",
          path: request.path,
        } as TBody,
      };
    } catch (error) {
      return {
        status: 503,
        body: {
          code: "t3_sdk_request_failed",
          message: error instanceof Error ? error.message : "Terminal 3 request failed.",
        } as TBody,
      };
    }
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
