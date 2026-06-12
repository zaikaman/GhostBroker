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
