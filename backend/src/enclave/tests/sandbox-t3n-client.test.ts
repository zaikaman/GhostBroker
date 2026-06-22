import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SdkAuthenticatedT3NetworkClient,
} from "../sandbox/t3n-client.js";

/**
 * Tests for the `SdkAuthenticatedT3NetworkClient` adapter. These
 * exercise the real dispatch logic against a hand-rolled fake
 * `TenantClient` and `T3nClient`, so they don't depend on the
 * T3N network or the WASM component. They assert that the legacy
 * `T3NetworkClient` path surface now flows through the SDK
 * methods the rest of the enclave expects to be calling.
 */

interface RecordedCall {
  method: string;
  args: unknown[];
}

class FakeTenant {
  public readonly calls: RecordedCall[] = [];

  public readonly tenant = {
    claim: vi.fn(async () => {
      this.calls.push({ method: "tenant.claim", args: [] });
      return { ok: true };
    }),
    me: vi.fn(async () => {
      this.calls.push({ method: "tenant.me", args: [] });
      return { tenant: "did:t3n:tenant:from-me" };
    }),
  };

  public readonly maps = {
    create: vi.fn(async (input: unknown) => {
      this.calls.push({ method: "maps.create", args: [input] });
      return { tail: (input as { tail: string }).tail, status: "created" };
    }),
  };

  public readonly contracts = {
    execute: vi.fn(async (tail: string, input: unknown) => {
      this.calls.push({ method: "contracts.execute", args: [tail, input] });
      return {
        outcome_ref: "outcome_from_sdk",
        execution_ref: "exec_from_sdk",
        decision: "matched",
      };
    }),
  };

  public controlPayload = vi.fn(async (functionName: string, body: unknown) => {
    this.calls.push({ method: "controlPayload", args: [functionName, body] });
    return { ok: true, functionName };
  });
}

class FakeT3n {
  public getUsage = vi.fn(async (opts: { limit: number }) => {
    return { balance: { available: 42 }, entries: [], nextSeq: null, options: opts };
  });
}

function makeClient(
  reauthenticate?: () => Promise<void>,
): { client: SdkAuthenticatedT3NetworkClient; fake: FakeTenant; t3n: FakeT3n } {
  const fake = new FakeTenant();
  const t3n = new FakeT3n();
  const client = new SdkAuthenticatedT3NetworkClient(
    t3n as unknown as ConstructorParameters<typeof SdkAuthenticatedT3NetworkClient>[0],
    fake as unknown as ConstructorParameters<typeof SdkAuthenticatedT3NetworkClient>[1],
    "did:t3n:tenant:authed",
    reauthenticate,
  );
  return { client, fake, t3n };
}

describe("SdkAuthenticatedT3NetworkClient — tenant DID paths", () => {
  it("resolves the cached tenant DID without touching the SDK", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ tenantDid: string }>({
      method: "POST",
      path: "/tenant/session/resolve",
    });
    expect(response.status).toBe(200);
    expect(response.body.tenantDid).toBe("did:t3n:tenant:authed");
    expect(fake.calls).toEqual([]);
  });

  it("registers the tenant via tenant.claim() and reads back via tenant.me()", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ tenantDid: string }>({
      method: "POST",
      path: "/tenant/register",
      body: { legalName: "Northstar", displayName: "Northstar" },
    });
    expect(response.status).toBe(200);
    expect(response.body.tenantDid).toBe("did:t3n:tenant:from-me");
    expect(fake.calls.map((call) => call.method)).toEqual([
      "tenant.claim",
      "tenant.me",
    ]);
  });

  it("falls back to the cached DID when tenant.me() omits the tenant field", async () => {
    const { client, fake } = makeClient();
    fake.tenant.me.mockResolvedValueOnce(
      {} as Awaited<ReturnType<typeof fake.tenant.me>>,
    );
    const response = await client.request<{ tenantDid: string }>({
      method: "POST",
      path: "/tenant/register",
    });
    expect(response.body.tenantDid).toBe("did:t3n:tenant:authed");
  });
});

describe("SdkAuthenticatedT3NetworkClient — token balance", () => {
  it("returns the available balance from t3n.getUsage()", async () => {
    const { client, t3n } = makeClient();
    const response = await client.request<{ account: string; available: string }>({
      method: "POST",
      path: "/tokens/balance",
    });
    expect(response.status).toBe(200);
    expect(response.body.account).toBe("did:t3n:tenant:authed");
    expect(response.body.available).toBe("42");
    expect(t3n.getUsage).toHaveBeenCalledWith({ limit: 1 });
  });

  it("returns 0 available when the SDK does not expose getUsage()", async () => {
    const { client } = makeClient();
    // Strip getUsage to simulate a narrow control-plane T3nClient.
    (client as unknown as { t3n: { getUsage?: unknown } }).t3n.getUsage =
      undefined;
    const response = await client.request<{ available: string }>({
      method: "POST",
      path: "/tokens/balance",
    });
    expect(response.body.available).toBe("0");
  });
});

describe("SdkAuthenticatedT3NetworkClient — tenant maps", () => {
  it("provisions a tenant map via tenant.maps.create() with numeric contract ids", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ status: string; tail: string }>({
      method: "POST",
      path: "/tenant/maps",
      body: {
        tail: "secrets",
        visibility: "private",
        writers: ["0", "1"],
        readers: ["0"],
      },
    });
    expect(response.status).toBe(200);
    expect(fake.calls).toEqual([
      {
        method: "maps.create",
        args: [
          {
            tail: "secrets",
            visibility: "private",
            writers: { Only: [0, 1] },
            readers: { Only: [0] },
          },
        ],
      },
    ]);
  });

  it("falls back to 'All' writers when no numeric ids are supplied", async () => {
    const { client, fake } = makeClient();
    const response = await client.request({
      method: "POST",
      path: "/tenant/maps",
      body: {
        tail: "authority-claims",
        visibility: "private",
        writers: ["contract:matching"],
        readers: [],
      },
    });
    expect(response.status).toBe(200);
    const createCall = fake.calls.find((call) => call.method === "maps.create");
    expect(createCall?.args[0]).toMatchObject({
      tail: "authority-claims",
      writers: "All",
    });
  });

  it("rejects maps requests without a tail", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ code: string; message: string }>({
      method: "POST",
      path: "/tenant/maps",
      body: { visibility: "private", writers: ["0"] },
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_sdk_validation_error");
    expect(response.body.message).toMatch(/missing map tail/);
    expect(fake.calls.find((call) => call.method === "maps.create")).toBeUndefined();
  });
});

describe("SdkAuthenticatedT3NetworkClient — contract execution", () => {
  it("dispatches /contracts/matching/blind-intents to seal-intent", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ outcome_ref: string }>({
      method: "POST",
      path: "/contracts/matching/blind-intents",
      body: {
        version: "0.3.0",
        input: { institutionId: "i1", agentDid: "a1" },
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.outcome_ref).toBe("outcome_from_sdk");
    expect(fake.calls).toContainEqual({
      method: "contracts.execute",
      args: [
        "matching",
        {
          version: "0.3.0",
          functionName: "seal-intent",
          input: { institutionId: "i1", agentDid: "a1" },
        },
      ],
    });
  });

  it("dispatches /contracts/matching/evaluate to evaluate-match", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ decision: string }>({
      method: "POST",
      path: "/contracts/matching/evaluate",
      body: {
        input: { buyIntentHandle: "b1", sellIntentHandle: "s1" },
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.decision).toBe("matched");
    const execCall = fake.calls.find(
      (call) => call.method === "contracts.execute",
    );
    expect(execCall?.args[1]).toMatchObject({
      functionName: "evaluate-match",
      input: { buyIntentHandle: "b1", sellIntentHandle: "s1" },
    });
  });

  it("defaults the contract version to 0.1.0 when the body omits it", async () => {
    const { client, fake } = makeClient();
    await client.request({
      method: "POST",
      path: "/contracts/matching/evaluate",
      body: { input: {} },
    });
    const execCall = fake.calls.find(
      (call) => call.method === "contracts.execute",
    );
    expect(execCall?.args[1]).toMatchObject({ version: "0.1.0" });
  });

  it("dispatches /contracts/negotiation/round-proposals to seal-round-proposal", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ outcome_ref: string }>({
      method: "POST",
      path: "/contracts/negotiation/round-proposals",
      body: {
        version: "0.9.0",
        sealed_envelope: "env",
        envelope_master_key_hex: "deadbeef",
        institution_did: "did:t3n:i1",
        agent_did: "did:t3n:a1",
        authority_ref: "auth",
        asset_code: "USD",
        side: "buy",
        correlation_ref: "corr",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.outcome_ref).toBe("outcome_from_sdk");
    expect(fake.calls).toContainEqual({
      method: "contracts.execute",
      args: [
        "matching",
        {
          version: "0.9.0",
          functionName: "seal-round-proposal",
          input: {
            sealed_envelope: "env",
            envelope_master_key_hex: "deadbeef",
            institution_did: "did:t3n:i1",
            agent_did: "did:t3n:a1",
            authority_ref: "auth",
            asset_code: "USD",
            side: "buy",
            correlation_ref: "corr",
          },
        },
      ],
    });
  });

  it("dispatches /contracts/negotiation/round-evaluation to evaluate-round", async () => {
    const { client, fake } = makeClient();
    const response = await client.request<{ decision: string }>({
      method: "POST",
      path: "/contracts/negotiation/round-evaluation",
      body: {
        version: "0.9.0",
        buy_proposal_handle: "round_b1",
        sell_proposal_handle: "round_s1",
        asset_code: "USD",
        correlation_ref: "corr",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.decision).toBe("matched");
    const execCall = fake.calls.find(
      (call) => call.method === "contracts.execute",
    );
    expect(execCall?.args[1]).toMatchObject({
      functionName: "evaluate-round",
      input: {
        buy_proposal_handle: "round_b1",
        sell_proposal_handle: "round_s1",
        asset_code: "USD",
        correlation_ref: "corr",
      },
    });
  });
});

describe("SdkAuthenticatedT3NetworkClient — runner lifecycle", () => {
  it("routes /runner/session through tenant.controlPayload", async () => {
    const { client, fake } = makeClient();
    const response = await client.request({
      method: "POST",
      path: "/runner/session",
      body: { tenantDid: "did:t3n:tenant:authed" },
    });
    expect(response.status).toBe(200);
    expect(fake.calls).toContainEqual({
      method: "controlPayload",
      args: ["runner.session.open", { tenantDid: "did:t3n:tenant:authed" }],
    });
  });

  it("routes /runner/session/close through tenant.controlPayload", async () => {
    const { client, fake } = makeClient();
    const response = await client.request({
      method: "POST",
      path: "/runner/session/close",
      body: { tenantDid: "did:t3n:tenant:authed" },
    });
    expect(response.status).toBe(200);
    expect(fake.calls).toContainEqual({
      method: "controlPayload",
      args: ["runner.session.close", { tenantDid: "did:t3n:tenant:authed" }],
    });
  });
});

describe("SdkAuthenticatedT3NetworkClient — unsupported paths", () => {
  it("returns 503 with code=unsupported_t3_sdk_operation for unknown paths", async () => {
    const { client } = makeClient();
    const response = await client.request<{ code: string; path: string }>({
      method: "GET",
      path: "/some/unsupported/path",
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("unsupported_t3_sdk_operation");
    expect(response.body.path).toBe("/some/unsupported/path");
  });
});

describe("SdkAuthenticatedT3NetworkClient — error classification", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies TenantSdkValidationError as t3_sdk_validation_error", async () => {
    const { client, fake } = makeClient();
    const validationError = new Error("bad input");
    validationError.name = "TenantSdkValidationError";
    fake.maps.create.mockRejectedValueOnce(validationError);
    const response = await client.request<{ code: string }>({
      method: "POST",
      path: "/tenant/maps",
      body: { tail: "x" },
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_sdk_validation_error");
  });

  it("classifies AuthenticationError as t3_auth_error", async () => {
    const { client, fake } = makeClient();
    const authError = new Error("session expired");
    authError.name = "SessionExpiredError";
    fake.contracts.execute.mockRejectedValueOnce(authError);
    const response = await client.request<{ code: string }>({
      method: "POST",
      path: "/contracts/matching/evaluate",
      body: { input: {} },
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_auth_error");
  });

  it("classifies RpcError as t3_rpc_error", async () => {
    const { client, fake } = makeClient();
    const rpcError = new Error("transport failed");
    rpcError.name = "RpcError";
    fake.contracts.execute.mockRejectedValueOnce(rpcError);
    const response = await client.request<{ code: string }>({
      method: "POST",
      path: "/contracts/matching/blind-intents",
      body: { input: {} },
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_rpc_error");
  });

  it("falls back to t3_sdk_request_failed for unknown error shapes", async () => {
    const { client, fake } = makeClient();
    fake.maps.create.mockRejectedValueOnce(new Error("boom"));
    const response = await client.request<{ code: string }>({
      method: "POST",
      path: "/tenant/maps",
      body: { tail: "x" },
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_sdk_request_failed");
  });

  it("re-authenticates and retries once when the session expired (SessionExpiredError)", async () => {
    const reauth = vi.fn(async () => undefined);
    const { client, fake } = makeClient(reauth);
    const sessionError = new Error("session expired");
    sessionError.name = "SessionExpiredError";
    // First call fails with session-expired, second call succeeds.
    fake.contracts.execute.mockRejectedValueOnce(sessionError);
    const response = await client.request<{ outcome_ref: string }>({
      method: "POST",
      path: "/contracts/matching/blind-intents",
      body: { input: {} },
    });
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body.outcome_ref).toBe("outcome_from_sdk");
  });

  it("re-authenticates and retries once when the session expired (RpcError 401 Session not found)", async () => {
    const reauth = vi.fn(async () => undefined);
    const { client, fake } = makeClient(reauth);
    const rpcError = new Error('HTTP 401: Unauthorized ({"code":"unauthorized","detail":"Session not found"})');
    rpcError.name = "RpcError";
    (rpcError as { httpStatus?: number }).httpStatus = 401;
    (rpcError as { detail?: string }).detail = "Session not found";
    fake.contracts.execute.mockRejectedValueOnce(rpcError);
    const response = await client.request<{ outcome_ref: string }>({
      method: "POST",
      path: "/contracts/negotiation/tickets",
      body: { input: {} },
    });
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body.outcome_ref).toBe("outcome_from_sdk");
  });

  it("does NOT retry for non-session-expiry RpcErrors (e.g. 500)", async () => {
    const reauth = vi.fn(async () => undefined);
    const { client, fake } = makeClient(reauth);
    const rpcError = new Error("HTTP 500: Internal error");
    rpcError.name = "RpcError";
    (rpcError as { httpStatus?: number }).httpStatus = 500;
    fake.contracts.execute.mockRejectedValueOnce(rpcError);
    const response = await client.request<{ code: string }>({
      method: "POST",
      path: "/contracts/matching/blind-intents",
      body: { input: {} },
    });
    expect(reauth).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_rpc_error");
  });

  it("returns the error after re-auth when the retry also fails", async () => {
    const reauth = vi.fn(async () => undefined);
    const { client, fake } = makeClient(reauth);
    const sessionError = new Error("session expired");
    sessionError.name = "SessionExpiredError";
    const otherError = new Error("contract panic");
    fake.contracts.execute
      .mockRejectedValueOnce(sessionError)
      .mockRejectedValueOnce(otherError);
    const response = await client.request<{ code: string }>({
      method: "POST",
      path: "/contracts/matching/blind-intents",
      body: { input: {} },
    });
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("t3_sdk_request_failed");
  });

  it("deduplicates concurrent re-auth attempts to a single handshake", async () => {
    const reauth = vi.fn(async () => {
      // Simulate a real round-trip delay so concurrent calls
      // arrive while the first re-auth is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const { client, fake } = makeClient(reauth);
    const sessionError = new Error("session expired");
    sessionError.name = "SessionExpiredError";
    fake.contracts.execute.mockRejectedValueOnce(sessionError);
    fake.contracts.execute.mockRejectedValueOnce(sessionError);
    // Fire two concurrent requests that both hit the session-expired path.
    const [r1, r2] = await Promise.all([
      client.request({ method: "POST", path: "/contracts/matching/blind-intents", body: { input: {} } }),
      client.request({ method: "POST", path: "/contracts/matching/evaluate", body: { input: {} } }),
    ]);
    // Only one re-auth round-trip should have happened even though
    // both requests saw the session-expired error.
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
