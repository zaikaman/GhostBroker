import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSealedEnvelope } from "./sealed-envelope.js";
import {
  AEAD_ENVELOPE_SCHEMA_VERSION,
  loadEnvelopeMasterKey,
  openEnvelope,
} from "../../enclave/keys/envelope-cipher.js";
import { decodeSealedEnvelope } from "../../enclave/matching/blind-intent.js";

const baseInput = {
  institutionId: "00000000-0000-4000-8000-000000000101",
  agentDid: "did:t3n:0xAgentAddress",
  authorityRef: "t3-delegation:abc123",
  assetCode: "WBTC",
  side: "buy" as const,
  quantity: 0.5,
  price: 70_000,
};

/**
 * A deterministic test master key so the AEAD round-trip is
 * reproducible across processes. Tests must inject this on
 * `buildSealedEnvelope` so they don't depend on the
 * `ENVELOPE_ENCRYPTION_MASTER_KEY` env var being set.
 */
function testMasterKey() {
  return loadEnvelopeMasterKey({
    ENVELOPE_ENCRYPTION_MASTER_KEY: randomBytes(32).toString("hex"),
  });
}

function decodeWithTestKey(
  envelope: string,
  institutionId: string,
  agentDid: string,
  authorityRef: string,
  masterKey = testMasterKey(),
) {
  return openEnvelope({
    institutionDid: institutionId,
    agentDid,
    authorityRef,
    envelope,
    masterKey,
  });
}

describe("buildSealedEnvelope", () => {
  it("produces a base64url envelope of at least 32 characters", () => {
    const result = buildSealedEnvelope({ ...baseInput, masterKey: testMasterKey() });
    expect(result.envelope.length).toBeGreaterThanOrEqual(32);
    expect(result.length).toBe(result.envelope.length);
  });

  it("the envelope is valid base64url and carries the AEAD version prefix", () => {
    const result = buildSealedEnvelope({ ...baseInput, masterKey: testMasterKey() });
    const versionPrefix = `${AEAD_ENVELOPE_SCHEMA_VERSION}|`;
    expect(result.envelope.startsWith(versionPrefix)).toBe(true);
    const body = result.envelope.slice(versionPrefix.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("round-trips through the AEAD cipher back to the input parameters", () => {
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    const decoded = decodeWithTestKey(
      result.envelope,
      baseInput.institutionId,
      baseInput.agentDid,
      baseInput.authorityRef,
      masterKey,
    );
    expect(decoded).toMatchObject({
      v: AEAD_ENVELOPE_SCHEMA_VERSION,
      institutionId: baseInput.institutionId,
      agentDid: baseInput.agentDid,
      authorityRef: baseInput.authorityRef,
      assetCode: "WBTC",
      side: "buy",
      quantity: 0.5,
      price: 70_000,
    });
    expect(typeof decoded.nonce).toBe("string");
    expect(decoded.nonce.length).toBeGreaterThan(0);
  });

  it("emits a fresh random GCM nonce each call (default)", () => {
    const masterKey = testMasterKey();
    const a = buildSealedEnvelope({ ...baseInput, masterKey });
    const b = buildSealedEnvelope({ ...baseInput, masterKey });
    expect(a.envelope).not.toBe(b.envelope);
    expect(a.handle).not.toBe(b.handle);
  });

  it("respects a caller-supplied intentNonce and encrypts it inside the payload", () => {
    const masterKey = testMasterKey();
    const a = buildSealedEnvelope({
      ...baseInput,
      intentNonce: "fixed-nonce",
      masterKey,
    });
    const b = buildSealedEnvelope({
      ...baseInput,
      intentNonce: "fixed-nonce",
      masterKey,
    });
    // The wire envelope differs (different GCM nonce + auth tag)
    // even when the caller-supplied payload nonce matches.
    expect(a.envelope).not.toBe(b.envelope);
    // The payload nonce is encrypted inside, so it round-trips
    // out of the AEAD-decoded payload.
    const decoded = decodeWithTestKey(
      a.envelope,
      baseInput.institutionId,
      baseInput.agentDid,
      baseInput.authorityRef,
      masterKey,
    );
    expect(decoded.nonce).toBe("fixed-nonce");
  });

  it("the handle is a 16-char hex prefix of the envelope's sha256", () => {
    const result = buildSealedEnvelope({ ...baseInput, masterKey: testMasterKey() });
    expect(result.handle).toMatch(/^[0-9a-f]{16}$/u);
    const expected = createHash("sha256").update(result.envelope).digest("hex").slice(0, 16);
    expect(result.handle).toBe(expected);
  });

  it("stamps a key version on the envelope metadata for audit", () => {
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    expect(result.keyVersion).toMatch(/^envelope-aead-v1:/u);
    expect(result.keyVersion).toContain(masterKey.keyFingerprint.slice(0, 16));
  });
});

describe("buildSealedEnvelope AEAD properties (P0 privacy)", () => {
  it("base64url-decoding the envelope does NOT expose plaintext JSON", () => {
    // The previous implementation was a base64url-encoded JSON
    // blob; anyone with Supabase read access could decode it.
    // The new envelope is a base64url-encoded ciphertext whose
    // raw bytes are an opaque AES-256-GCM body (nonce || ct ||
    // tag) -- there is no JSON in the decode path.
    const result = buildSealedEnvelope({ ...baseInput, masterKey: testMasterKey() });
    const sep = result.envelope.indexOf("|");
    expect(sep).toBeGreaterThan(0);
    const body = result.envelope.slice(sep + 1);
    const raw = Buffer.from(body, "base64url");
    // A JSON plaintext would start with `{` (0x7B); the AEAD
    // body should never start with that byte for a properly
    // sealed envelope, and the raw bytes should not parse as
    // JSON in any case.
    expect(raw[0]).not.toBe(0x7b);
    let parsedAsJson = false;
    try {
      JSON.parse(raw.toString("utf8"));
      parsedAsJson = true;
    } catch {
      // Raw AEAD bytes do not parse as JSON; the
      // initialized `false` is the expected outcome.
    }
    expect(parsedAsJson).toBe(false);
  });

  it("rejects any tamper of the ciphertext body (AEAD tag verification)", () => {
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    const sep = result.envelope.indexOf("|");
    const prefix = result.envelope.slice(0, sep + 1);
    const body = result.envelope.slice(sep + 1);
    // Flip a single base64url character in the middle of the
    // ciphertext body. AES-256-GCM tag verification must fail.
    const flippedChar = body[Math.floor(body.length / 2)] === "A" ? "B" : "A";
    const tamperedBody =
      body.slice(0, Math.floor(body.length / 2)) +
      flippedChar +
      body.slice(Math.floor(body.length / 2) + 1);
    const tampered = `${prefix}${tamperedBody}`;
    expect(() =>
      decodeWithTestKey(
        tampered,
        baseInput.institutionId,
        baseInput.agentDid,
        baseInput.authorityRef,
        masterKey,
      ),
    ).toThrow();
  });

  it("rejects a re-seal under a different master key (wrong-key AEAD)", () => {
    const sealKey = testMasterKey();
    const openKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey: sealKey });
    expect(() =>
      decodeWithTestKey(
        result.envelope,
        baseInput.institutionId,
        baseInput.agentDid,
        baseInput.authorityRef,
        openKey,
      ),
    ).toThrow();
  });

  it("rejects the envelope when the caller lies about the institution DID", () => {
    // The AAD binds the ciphertext to the institution DID. A
    // row swap between institutions cannot pass tag verification
    // even when the same master key is used (because the AAD
    // is included in the GCM tag computation).
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    expect(() =>
      decodeWithTestKey(
        result.envelope,
        "00000000-0000-4000-8000-000000000999",
        baseInput.agentDid,
        baseInput.authorityRef,
        masterKey,
      ),
    ).toThrow();
  });

  it("rejects the envelope when the caller lies about the agent DID", () => {
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    expect(() =>
      decodeWithTestKey(
        result.envelope,
        baseInput.institutionId,
        "did:t3n:attacker",
        baseInput.authorityRef,
        masterKey,
      ),
    ).toThrow();
  });

  it("rejects the envelope when the caller lies about the authority ref", () => {
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    expect(() =>
      decodeWithTestKey(
        result.envelope,
        baseInput.institutionId,
        baseInput.agentDid,
        "ghostbroker-delegation:forged",
        masterKey,
      ),
    ).toThrow();
  });

  it("decodeSealedEnvelope (orchestrator-side) round-trips the same payload", () => {
    const masterKey = testMasterKey();
    const result = buildSealedEnvelope({ ...baseInput, masterKey });
    // The orchestrator's in-process test path uses
    // decodeSealedEnvelope to derive the lock descriptor when
    // the T3N stub does not emit the v0.8.0 lock fields. The
    // function must accept the AEAD envelope from buildSealedEnvelope
    // and return the same structured payload.
    const decoded = decodeSealedEnvelope(
      result.envelope,
      {
        institutionDid: baseInput.institutionId,
        agentDid: baseInput.agentDid,
        authorityRef: baseInput.authorityRef,
      },
      masterKey,
    );
    expect(decoded.quantity).toBe(baseInput.quantity);
    expect(decoded.price).toBe(baseInput.price);
    expect(decoded.assetCode).toBe(baseInput.assetCode);
    expect(decoded.side).toBe(baseInput.side);
  });

  it("the AEAD body length exceeds the legacy plaintext minimum", () => {
    // The plaintext JSON was ~140 bytes for the base input;
    // the AEAD body (nonce + ciphertext + tag) is at least 28
    // bytes larger because of the 12-byte GCM nonce and 16-byte
    // auth tag. The schema's 32-char base64url minimum still
    // binds -- this is a guard against accidentally producing
    // a too-short envelope through some future refactor.
    const result = buildSealedEnvelope({ ...baseInput, masterKey: testMasterKey() });
    const sep = result.envelope.indexOf("|");
    const body = result.envelope.slice(sep + 1);
    expect(body.length).toBeGreaterThan(40);
  });
});
