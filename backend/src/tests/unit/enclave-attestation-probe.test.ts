import { describe, expect, it } from "vitest";
import { probeEnclaveAttestation } from "../../api/health.routes.js";
import type {
  T3NetworkClient,
  T3NetworkRequest,
  T3NetworkResponse,
} from "../../enclave/sandbox/t3n-client.js";
import { loadEnvelopeMasterKey, type EnvelopeMasterKey } from "../../enclave/keys/envelope-cipher.js";

function fakeClient(
  respond: (request: T3NetworkRequest) => T3NetworkResponse,
): T3NetworkClient {
  return {
    request: <TBody = unknown>(request: T3NetworkRequest) =>
      Promise.resolve(respond(request) as T3NetworkResponse<TBody>),
  };
}

function testMasterKey(): EnvelopeMasterKey {
  return loadEnvelopeMasterKey({
    ENVELOPE_ENCRYPTION_MASTER_KEY: "0".repeat(64),
  });
}

describe("probeEnclaveAttestation", () => {
  it("returns verified=true with the TEE-issued handle + attestation ref on a 2xx", async () => {
    const client = fakeClient(() => ({
      status: 200,
      body: {
        intent_handle: "intent_abc123",
        execution_ref: "t3exec_xyz",
        attestation_ref: "t3attest:seal_abc123",
      },
    }));

    const quote = await probeEnclaveAttestation({
      networkClient: client,
      contractVersion: "0.9.1",
      tenantDid: "did:t3n:test",
      correlationRef: "enclave-attestation-verify:probe-1",
      envelopeMasterKey: testMasterKey(),
    });

    expect(quote.verified).toBe(true);
    expect(quote.error).toBeNull();
    expect(quote.teeResponse).toEqual({
      intentHandle: "intent_abc123",
      executionRef: "t3exec_xyz",
      attestationRef: "t3attest:seal_abc123",
      responseStatus: 200,
    });
  });

  it("posts to the seal-intent route with a real AEAD envelope, master key hex, and the pinned version", async () => {
    let captured: T3NetworkRequest | undefined;
    const client = fakeClient((request) => {
      captured = request;
      return {
        status: 200,
        body: { intent_handle: "intent_h", attestation_ref: "t3attest:h" },
      };
    });

    await probeEnclaveAttestation({
      networkClient: client,
      contractVersion: "0.9.1",
      tenantDid: "did:t3n:test",
      correlationRef: "enclave-attestation-verify:probe-2",
      envelopeMasterKey: testMasterKey(),
    });

    expect(captured?.method).toBe("POST");
    expect(captured?.path).toBe("/contracts/matching/blind-intents");
    const body = captured?.body as Record<string, unknown>;
    expect(body.version).toBe("0.9.1");
    expect(body.correlation_ref).toBe("enclave-attestation-verify:probe-2");
    expect(body.agent_did).toBe("did:t3n:enclave-attestation-verify");
    // The probe envelope must be a real AEAD ciphertext (the v0.9.1
    // contract decrypts it inside the TEE using the master key hex).
    expect(String(body.encrypted_intent)).toMatch(/^ghostbroker\.envelope\.aead\/v1\|/);
    // The master key hex must be present and 64 hex chars.
    expect(typeof body.envelope_master_key_hex).toBe("string");
    expect(String(body.envelope_master_key_hex)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("classifies an unregistered contract (404 not_found) as verification failed", async () => {
    const client = fakeClient(() => ({
      status: 404,
      body: {
        code: "not_found",
        detail: "tenant contract did:t3n:test:matching not registered",
      },
    }));

    const quote = await probeEnclaveAttestation({
      networkClient: client,
      contractVersion: "0.9.1",
      tenantDid: "did:t3n:test",
      correlationRef: "enclave-attestation-verify:probe-3",
      envelopeMasterKey: testMasterKey(),
    });

    expect(quote.verified).toBe(false);
    expect(quote.teeResponse).toBeNull();
    expect(quote.error).toContain("not registered");
  });

  it("surfaces a non-2xx rejection as verification failed with the upstream detail", async () => {
    const client = fakeClient(() => ({
      status: 400,
      body: { message: "invalid envelope schema" },
    }));

    const quote = await probeEnclaveAttestation({
      networkClient: client,
      contractVersion: "0.9.1",
      tenantDid: "did:t3n:test",
      correlationRef: "enclave-attestation-verify:probe-4",
      envelopeMasterKey: testMasterKey(),
    });

    expect(quote.verified).toBe(false);
    expect(quote.teeResponse).toBeNull();
    expect(quote.error).toContain("invalid envelope schema");
  });

  it("flags a 2xx with no intent_handle as a possible stub", async () => {
    const client = fakeClient(() => ({
      status: 200,
      body: {},
    }));

    const quote = await probeEnclaveAttestation({
      networkClient: client,
      contractVersion: "0.9.1",
      tenantDid: "did:t3n:test",
      correlationRef: "enclave-attestation-verify:probe-5",
      envelopeMasterKey: testMasterKey(),
    });

    expect(quote.verified).toBe(false);
    expect(quote.teeResponse).not.toBeNull();
    expect(quote.teeResponse?.intentHandle).toBeNull();
    expect(quote.error).toContain("stub");
  });
});
