import { describe, expect, it } from "vitest";
import {
  AEAD_ENVELOPE_SCHEMA_VERSION,
  buildEnvelopeAad,
  envelopeCipherKeyVersion,
  loadEnvelopeMasterKey,
  openEnvelope,
  sealEnvelope,
} from "./envelope-cipher.js";

function buildKey(hexSeed: string) {
  // Deterministic 32-byte test master key derived from a hex
  // seed (used to make failure scenarios easy to reason
  // about; production callers resolve the master key from the
  // `ENVELOPE_ENCRYPTION_MASTER_KEY` env var).
  const padded = (hexSeed + "0".repeat(64)).slice(0, 64);
  return loadEnvelopeMasterKey({ ENVELOPE_ENCRYPTION_MASTER_KEY: padded });
}

const baseSealInput = {
  institutionDid: "did:t3n:institution:us2",
  agentDid: "did:t3n:agent:us2-authorized",
  authorityRef: "authority:us2:intent-submit",
  payload: {
    institutionId: "00000000-0000-4000-8000-000000000201",
    agentDid: "did:t3n:agent:us2-authorized",
    authorityRef: "authority:us2:intent-submit",
    assetCode: "WBTC",
    side: "buy" as const,
    quantity: 0.5,
    price: 70_000,
    nonce: "nonce-test",
  },
};

describe("envelope-cipher master key loader", () => {
  it("loads a 64-hex master key from env", () => {
    const master = loadEnvelopeMasterKey({
      ENVELOPE_ENCRYPTION_MASTER_KEY: "0".repeat(64),
    });
    expect(master.key.length).toBe(32);
    expect(master.fromDevFallback).toBe(false);
    expect(master.keyFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("falls back to a deterministic dev key when env is empty", () => {
    const master = loadEnvelopeMasterKey({});
    expect(master.key.length).toBe(32);
    expect(master.fromDevFallback).toBe(true);
  });

  it("throws on a too-short master key (malformed shape)", () => {
    expect(() =>
      loadEnvelopeMasterKey({
        ENVELOPE_ENCRYPTION_MASTER_KEY: "deadbeef",
      }),
    ).toThrow(/64 hex characters/);
  });

  it("throws on malformed master keys that are exactly 64 hex chars with non-hex content", () => {
    expect(() =>
      loadEnvelopeMasterKey({
        ENVELOPE_ENCRYPTION_MASTER_KEY: "z".repeat(64),
      }),
    ).toThrow(/64 hex characters/);
  });

  it("the dev fallback is deterministic across calls", () => {
    const a = loadEnvelopeMasterKey({});
    const b = loadEnvelopeMasterKey({});
    expect(a.key.equals(b.key)).toBe(true);
    expect(a.keyFingerprint).toBe(b.keyFingerprint);
  });
});

describe("envelope-cipher sealEnvelope / openEnvelope round-trip", () => {
  it("returns the structured payload from an AEAD envelope", () => {
    const masterKey = buildKey("a1");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const opened = openEnvelope({ ...baseSealInput, envelope, masterKey });
    expect(opened).toMatchObject({
      v: AEAD_ENVELOPE_SCHEMA_VERSION,
      institutionId: baseSealInput.payload.institutionId,
      agentDid: baseSealInput.payload.agentDid,
      authorityRef: baseSealInput.payload.authorityRef,
      assetCode: "WBTC",
      side: "buy",
      quantity: 0.5,
      price: 70_000,
      nonce: "nonce-test",
    });
  });

  it("emits a fresh random GCM nonce per call", () => {
    const masterKey = buildKey("a2");
    const a = sealEnvelope({ ...baseSealInput, masterKey });
    const b = sealEnvelope({ ...baseSealInput, masterKey });
    expect(a).not.toBe(b);
  });

  it("rejects envelopes produced under a different master key", () => {
    const sealKey = buildKey("a3");
    const openKey = buildKey("a4");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey: sealKey });
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope, masterKey: openKey }),
    ).toThrow(/failed AEAD tag verification/);
  });

  it("rejects ciphertext body tamper (single-bit flip)", () => {
    const masterKey = buildKey("a5");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const sep = envelope.indexOf("|");
    const prefix = envelope.slice(0, sep + 1);
    const body = envelope.slice(sep + 1);
    const idx = Math.floor(body.length / 2);
    const flippedChar = body[idx] === "A" ? "B" : "A";
    const tampered = `${prefix}${body.slice(0, idx)}${flippedChar}${body.slice(idx + 1)}`;
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: tampered, masterKey }),
    ).toThrow(/failed AEAD tag verification/);
  });

  it("rejects authTag tamper", () => {
    const masterKey = buildKey("a6");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const sep = envelope.indexOf("|");
    const prefix = envelope.slice(0, sep + 1);
    const body = envelope.slice(sep + 1);
    const rawBytes = Buffer.from(body, "base64url");
    // Flip a bit in the auth tag (last 16 bytes).
    const tagIdx = rawBytes.length - 1;
    if (tagIdx >= 0) {
      rawBytes[tagIdx] = (rawBytes[tagIdx] ?? 0) ^ 0x01;
    }
    const tampered = `${prefix}${rawBytes.toString("base64url")}`;
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: tampered, masterKey }),
    ).toThrow(/failed AEAD tag verification/);
  });

  it("rejects nonce tamper", () => {
    const masterKey = buildKey("a7");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const sep = envelope.indexOf("|");
    const prefix = envelope.slice(0, sep + 1);
    const body = envelope.slice(sep + 1);
    const rawBytes = Buffer.from(body, "base64url");
    // Flip a bit in the first byte (the GCM nonce).
    if (rawBytes.length > 0) {
      rawBytes[0] = (rawBytes[0] ?? 0) ^ 0x01;
    }
    const tampered = `${prefix}${rawBytes.toString("base64url")}`;
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: tampered, masterKey }),
    ).toThrow(/failed AEAD tag verification/);
  });

  it("rejects AAD mismatches (institution / agent / authority)", () => {
    const masterKey = buildKey("a8");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const swap = (overrides: Partial<typeof baseSealInput>) =>
      openEnvelope({ ...baseSealInput, ...overrides, envelope, masterKey });
    expect(() => swap({ institutionDid: "did:t3n:institution:other" })).toThrow();
    expect(() => swap({ agentDid: "did:t3n:agent:attacker" })).toThrow();
    expect(() =>
      swap({ authorityRef: "ghostbroker-delegation:forged" }),
    ).toThrow();
  });

  it("rejects envelopes with a wrong version prefix", () => {
    const masterKey = buildKey("a9");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const sep = envelope.indexOf("|");
    const body = envelope.slice(sep + 1);
    const tampered = `ghostbroker.envelope.aead/v999|${body}`;
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: tampered, masterKey }),
    ).toThrow(/schema version mismatch/);
  });

  it("rejects envelopes that are too short to carry nonce + tag", () => {
    const masterKey = buildKey("b1");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const sep = envelope.indexOf("|");
    const body = envelope.slice(sep + 1);
    const truncated = `${envelope.slice(0, sep + 1)}${body.slice(0, 4)}`;
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: truncated, masterKey }),
    ).toThrow(/AEAD nonce\+tag minimum/);
  });

  it("rejects envelopes missing the version separator", () => {
    const masterKey = buildKey("b2");
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: "no-separator", masterKey }),
    ).toThrow(/missing the version separator/);
  });

  it("rejects envelopes with malformed base64url body", () => {
    const masterKey = buildKey("b3");
    const envelope = sealEnvelope({ ...baseSealInput, masterKey });
    const sep = envelope.indexOf("|");
    const tampered = `${envelope.slice(0, sep + 1)}@@@@@@@@@@`;
    expect(() =>
      openEnvelope({ ...baseSealInput, envelope: tampered, masterKey }),
    ).toThrow();
  });
});

describe("envelope-cipher input validation", () => {
  it("rejects non-positive quantity", () => {
    const masterKey = buildKey("c1");
    expect(() =>
      sealEnvelope({
        ...baseSealInput,
        masterKey,
        payload: { ...baseSealInput.payload, quantity: 0 },
      }),
    ).toThrow(/quantity/);
    expect(() =>
      sealEnvelope({
        ...baseSealInput,
        masterKey,
        payload: { ...baseSealInput.payload, quantity: -1 },
      }),
    ).toThrow(/quantity/);
  });

  it("rejects non-positive price", () => {
    const masterKey = buildKey("c2");
    expect(() =>
      sealEnvelope({
        ...baseSealInput,
        masterKey,
        payload: { ...baseSealInput.payload, price: 0 },
      }),
    ).toThrow(/price/);
  });

  it("rejects invalid side", () => {
    const masterKey = buildKey("c3");
    expect(() =>
      sealEnvelope({
        ...baseSealInput,
        masterKey,
        payload: { ...baseSealInput.payload, side: "hold" as never },
      }),
    ).toThrow(/side/);
  });

  it("rejects empty AAD components", () => {
    expect(() =>
      buildEnvelopeAad({
        institutionDid: "",
        agentDid: "did:t3n:agent:x",
        authorityRef: "auth",
      }),
    ).toThrow();
  });
});

describe("envelope-cipher key-version metadata", () => {
  it("exposes a stable key-version string for audit", () => {
    expect(envelopeCipherKeyVersion()).toBe("envelope-aead-v1");
  });
});

describe("envelope-cipher per-institution key isolation", () => {
  it("envelopes sealed for one institution cannot be opened for another", () => {
    const masterKey = buildKey("d1");
    const envelopeA = sealEnvelope({ ...baseSealInput, masterKey });
    const envelopeB = sealEnvelope({
      ...baseSealInput,
      institutionDid: "did:t3n:institution:us3",
      payload: {
        ...baseSealInput.payload,
        institutionId: "00000000-0000-4000-8000-000000000301",
      },
      masterKey,
    });
    // AAD institution binding already prevents cross-tenant
    // replay even with the same master key. Re-confirm by
    // attempting to open each envelope under the wrong
    // institution identity.
    expect(() =>
      openEnvelope({
        ...baseSealInput,
        envelope: envelopeA,
        institutionDid: "did:t3n:institution:us3",
        masterKey,
      }),
    ).toThrow();
    expect(() =>
      openEnvelope({
        ...baseSealInput,
        envelope: envelopeB,
        masterKey,
      }),
    ).toThrow();
  });
});
