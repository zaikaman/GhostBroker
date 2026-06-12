import { describe, expect, it } from "vitest";
import { createSealedSecretMapDefinition } from "../keys/sealed-secret-maps.js";

describe("sealed secret maps", () => {
  it("requires explicit private map readers and writers", () => {
    expect(() =>
      createSealedSecretMapDefinition({
        tenantDid: "did:t3n:tenant:ghostbroker",
        tail: "secrets",
        readers: [],
        writers: ["contract:matching"],
      }),
    ).toThrow(/explicit readers and writers/);
  });

  it("creates canonical tenant map names with sorted ACLs", () => {
    expect(
      createSealedSecretMapDefinition({
        tenantDid: "did:t3n:tenant:ghostbroker",
        tail: "authority-claims",
        readers: ["contract:settlement", "contract:matching"],
        writers: ["control-plane", "contract:matching"],
      }),
    ).toEqual({
      tenantDid: "did:t3n:tenant:ghostbroker",
      tail: "authority-claims",
      canonicalName: "z:ghostbroker:authority-claims",
      acl: {
        readers: ["contract:matching", "contract:settlement"],
        writers: ["contract:matching", "control-plane"],
      },
    });
  });
});
