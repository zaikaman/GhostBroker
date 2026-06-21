import { describe, expect, it } from "vitest";
import {
  BlindIntentSealFailureError,
  T3BlindIntentClient,
  classifyBlindIntentSealFailure,
  type BlindIntentRequest,
} from "../matching/blind-intent.js";
import { sealEnvelope } from "../keys/envelope-cipher.js";
import type {
  T3NetworkClient,
  T3NetworkRequest,
  T3NetworkResponse,
} from "../sandbox/t3n-client.js";
import type { TokenBalanceClient, TokenBalance } from "../sandbox/token-balance.js";

const BLINDING_TEST_MASTER_KEY = "0".repeat(64);
process.env["ENVELOPE_ENCRYPTION_MASTER_KEY"] = BLINDING_TEST_MASTER_KEY;
const BLINDING_TEST_MASTER_KEY_HEX = BLINDING_TEST_MASTER_KEY;

class CapturingNetworkClient implements T3NetworkClient {
  public requests: T3NetworkRequest[] = [];

  public status = 202;
  public body: unknown = {
    intent_handle: "intent_t3_opaque",
    execution_ref: "t3exec_opaque",
  };

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    this.requests.push(request);
    return {
      status: this.status,
      body: this.body as TBody,
    };
  }
}

class ReadyTokenClient implements TokenBalanceClient {
  public checked = false;

  public async getBalance(account: string): Promise<TokenBalance> {
    return {
      account,
      available: 10n,
      minimumRequired: 0n,
    };
  }

  public async assertMinimumBalance(
    account: string,
    minimumRequired: bigint,
  ): Promise<TokenBalance> {
    this.checked = true;
    return {
      account,
      available: 10n,
      minimumRequired,
    };
  }
}

/**
 * The envelope is an AEAD-sealed
 * `ghostbroker.envelope.aead/v1` envelope produced by
 * `sealEnvelope`. The in-process test path uses the cipher
 * directly so the seal stub can re-decode the envelope to
 * derive the fallback lock descriptor; production T3N
 * responses include the descriptor on the wire and skip the
 * decode.
 */
const testEnvelope = sealEnvelope({
  institutionDid: "00000000-0000-4000-8000-000000000201",
  agentDid: "did:t3n:agent:us2-authorized",
  authorityRef: "authority:us2:intent-submit",
  payload: {
    institutionId: "00000000-0000-4000-8000-000000000201",
    agentDid: "did:t3n:agent:us2-authorized",
    authorityRef: "authority:us2:intent-submit",
    assetCode: "WBTC",
    side: "buy",
    quantity: 1,
    price: 45000,
    nonce: "nonce-test",
  },
  masterKey: {
    key: Buffer.from(BLINDING_TEST_MASTER_KEY, "hex"),
    keyFingerprint: "test-fingerprint",
    fromDevFallback: false,
  },
});

const request: BlindIntentRequest = {
  institutionId: "00000000-0000-4000-8000-000000000201",
  agentDid: "did:t3n:agent:us2-authorized",
  encryptedIntentEnvelope: testEnvelope,
  authorityRef: "authority:us2:intent-submit",
  correlationRef: "corr_us2",
};

describe("blind intent client", () => {
  it("converts encrypted payloads into opaque handles only", async () => {
    const networkClient = new CapturingNetworkClient();
    const tokenClient = new ReadyTokenClient();
    const client = new T3BlindIntentClient({
      networkClient,
      tokenBalanceClient: tokenClient,
      tokenAccount: "did:t3n:institution:us2",
      minimumTokenBalance: 1n,
      envelopeMasterKeyHex: BLINDING_TEST_MASTER_KEY_HEX,
    });

    await expect(client.sealIntent(request)).resolves.toMatchObject({
      intentHandle: "intent_t3_opaque",
      state: "intent_sealed",
      executionRef: "t3exec_opaque",
      sealedAt: expect.any(String) as string,
      // The TEE-attested lock descriptor. The stub network
      // client in this test does not return a `lock_descriptor`
      // body field, so the in-process fallback re-decodes the
      // envelope (which is the canonical `ghostbroker.envelope/1`
      // format). The fallback cannot decode the test's
      // `t3env.safe.ciphertext` envelope, so this assertion
      // only checks the opaque fields -- the lock descriptor
      // has its own unit test in the privacy-redaction suite.
    });
    expect(tokenClient.checked).toBe(true);
    // The on-the-wire body is snake_case to match the TEE
    // contract's `SealIntentInput` deserializer in
    // contracts/matching-policy/src/lib.rs. The public
    // `BlindIntentRequest` is camelCase; the translation lives
    // in `T3BlindIntentClient.sealIntent`. See the comment
    // there for the field-by-field mapping.
    expect(networkClient.requests[0]?.body).toEqual({
      institution_id: request.institutionId,
      agent_did: request.agentDid,
      encrypted_intent: request.encryptedIntentEnvelope,
      envelope_master_key_hex: BLINDING_TEST_MASTER_KEY_HEX,
      authority_ref: request.authorityRef,
      correlation_ref: request.correlationRef,
    });
  });

  it("throws BlindIntentSealFailureError classified as contract_not_registered on T3N 404", async () => {
    const networkClient = new CapturingNetworkClient();
    networkClient.status = 404;
    networkClient.body = {
      code: "not_found",
      detail:
        "tenant contract did:t3n:tenant:abc:matching not registered",
      request_id: "req-001",
    };
    const tokenClient = new ReadyTokenClient();
    const client = new T3BlindIntentClient({
      networkClient,
      tokenBalanceClient: tokenClient,
      tokenAccount: "did:t3n:institution:us2",
      minimumTokenBalance: 1n,
      envelopeMasterKeyHex: BLINDING_TEST_MASTER_KEY_HEX,
    });

    await expect(client.sealIntent(request)).rejects.toMatchObject({
      name: "BlindIntentSealFailureError",
      kind: "contract_not_registered",
      status: 404,
    });
    await expect(client.sealIntent(request)).rejects.toBeInstanceOf(
      BlindIntentSealFailureError,
    );
  });

  it("classifies a 503 with t3_sdk_request_failed wrapping a 'not registered' detail as contract_not_registered", async () => {
    const networkClient = new CapturingNetworkClient();
    networkClient.status = 503;
    networkClient.body = {
      code: "t3_sdk_request_failed",
      message:
        "HTTP 404: Method not found ({\"code\":\"not_found\",\"detail\":\"tenant contract did:t3n:tenant:abc:matching not registered\"})",
    };
    const tokenClient = new ReadyTokenClient();
    const client = new T3BlindIntentClient({
      networkClient,
      tokenBalanceClient: tokenClient,
      tokenAccount: "did:t3n:institution:us2",
      minimumTokenBalance: 1n,
      envelopeMasterKeyHex: BLINDING_TEST_MASTER_KEY_HEX,
    });

    await expect(client.sealIntent(request)).rejects.toMatchObject({
      kind: "contract_not_registered",
      status: 503,
    });
  });

  it("classifies a generic 502 T3N rejection as t3_request_failed and preserves the upstream body on the error", async () => {
    const networkClient = new CapturingNetworkClient();
    networkClient.status = 502;
    networkClient.body = { code: "upstream_error", message: "T3N gateway timeout" };
    const tokenClient = new ReadyTokenClient();
    const client = new T3BlindIntentClient({
      networkClient,
      tokenBalanceClient: tokenClient,
      tokenAccount: "did:t3n:institution:us2",
      minimumTokenBalance: 1n,
      envelopeMasterKeyHex: BLINDING_TEST_MASTER_KEY_HEX,
    });

    let caught: BlindIntentSealFailureError | undefined;
    try {
      await client.sealIntent(request);
    } catch (error) {
      caught = error as BlindIntentSealFailureError;
    }
    expect(caught).toBeInstanceOf(BlindIntentSealFailureError);
    expect(caught?.kind).toBe("t3_request_failed");
    expect(caught?.status).toBe(502);
    expect(caught?.upstreamBody).toEqual({
      code: "upstream_error",
      message: "T3N gateway timeout",
    });
  });
});

describe("classifyBlindIntentSealFailure", () => {
  it("extracts the contract name from a T3N 'tenant contract <did>:<name> not registered' detail", () => {
    const result = classifyBlindIntentSealFailure(404, {
      code: "not_found",
      detail: "tenant contract did:t3n:tenant:xyz:matching not registered",
    });
    expect(result.kind).toBe("contract_not_registered");
    expect(result.message).toContain("'matching'");
  });

  it("falls back to a generic contract name when the detail string shape is unknown", () => {
    const result = classifyBlindIntentSealFailure(404, {
      code: "not_found",
      detail: "some other not registered error",
    });
    expect(result.kind).toBe("contract_not_registered");
    expect(result.message).toContain("'matching'");
  });

  it("classifies a non-registered-style 5xx as t3_request_failed with the upstream message preserved", () => {
    const result = classifyBlindIntentSealFailure(502, {
      code: "upstream_error",
      message: "T3N gateway timeout",
    });
    expect(result.kind).toBe("t3_request_failed");
    expect(result.message).toBe("T3N gateway timeout");
  });

  it("falls back to a synthesized message when the upstream body is empty", () => {
    const result = classifyBlindIntentSealFailure(500, {});
    expect(result.kind).toBe("t3_request_failed");
    expect(result.message).toContain("HTTP 500");
  });
});
