import { describe, expect, it } from "vitest";
import { generateAgentIdentity } from "../services/agent-identity";

describe("agent-identity generator", () => {
  it("generates a valid DID format", () => {
    const id = generateAgentIdentity();
    expect(id.agentDid).toMatch(/^did:t3n:0x[0-9a-f]{40}$/);
    expect(id.publicKey).toMatch(/^0x[0-9a-f]{66}$/);
    expect(id.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(id.ethAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
