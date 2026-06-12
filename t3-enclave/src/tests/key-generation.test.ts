import { describe, expect, it } from "vitest";
import { createEnvelopeKeyMetadata } from "../keys/key-generation.js";
import { rotateEnvelopeKey } from "../keys/key-rotation.js";

describe("envelope key generation", () => {
  it("creates per-institution key metadata without secret material", () => {
    const metadata = createEnvelopeKeyMetadata({
      institutionDid: "did:t3n:institution:us2",
      purpose: "hidden_intent",
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(metadata.institutionDid).toBe("did:t3n:institution:us2");
    expect(metadata.keyVersion).toContain("hidden_intent");
    expect(metadata.publicKeyRef).toMatch(/^t3-key:/u);
    expect(Object.keys(metadata)).not.toContain("privateKey");
  });

  it("rotates to a new key version", () => {
    const rotation = rotateEnvelopeKey({
      institutionDid: "did:t3n:institution:us2",
      purpose: "receipt",
      previousKeyVersion: "receipt:previous",
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(rotation.previousKeyVersion).toBe("receipt:previous");
    expect(rotation.current.keyVersion).not.toBe("receipt:previous");
    expect(rotation.rotatedAt).toBe("2026-06-12T00:00:00.000Z");
  });
});
