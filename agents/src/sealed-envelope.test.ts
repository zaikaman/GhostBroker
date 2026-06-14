import { describe, expect, it } from "vitest";
import { buildSealedEnvelope } from "./sealed-envelope.js";

describe("buildSealedEnvelope", () => {
  const baseInput = {
    institutionId: "00000000-0000-4000-8000-000000000101",
    agentDid: "did:t3n:0xAgentAddress",
    authorityRef: "t3-delegation:abc123",
    assetCode: "WBTC",
    side: "buy" as const,
    quantity: 0.5,
    price: 70_000,
  };

  it("produces a base64url envelope of at least 32 characters", () => {
    const result = buildSealedEnvelope(baseInput);
    expect(result.envelope.length).toBeGreaterThanOrEqual(32);
    expect(result.length).toBe(result.envelope.length);
  });

  it("the envelope is valid base64url", () => {
    const result = buildSealedEnvelope(baseInput);
    expect(result.envelope).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("decodes back to JSON with the input parameters", () => {
    const result = buildSealedEnvelope(baseInput);
    const decoded = JSON.parse(Buffer.from(result.envelope, "base64url").toString("utf8"));
    expect(decoded).toMatchObject({
      v: "ghostbroker.envelope/1",
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

  it("emits a different nonce each call (default)", () => {
    const a = buildSealedEnvelope(baseInput);
    const b = buildSealedEnvelope(baseInput);
    expect(a.envelope).not.toBe(b.envelope);
    expect(a.handle).not.toBe(b.handle);
  });

  it("respects a caller-supplied intentNonce for determinism", () => {
    const a = buildSealedEnvelope({ ...baseInput, intentNonce: "fixed-nonce" });
    const b = buildSealedEnvelope({ ...baseInput, intentNonce: "fixed-nonce" });
    expect(a.envelope).toBe(b.envelope);
  });

  it("the handle is a 16-char hex prefix of the envelope's sha256", () => {
    const result = buildSealedEnvelope(baseInput);
    expect(result.handle).toMatch(/^[0-9a-f]{16}$/u);
  });
});
