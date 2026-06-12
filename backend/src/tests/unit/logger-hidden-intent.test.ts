import { describe, expect, it } from "vitest";
import { redactForbiddenOrderFields } from "../../logging/logger.js";

describe("hidden intent log scrubbing", () => {
  it("redacts plaintext trading fields before structured logging", () => {
    const redacted = redactForbiddenOrderFields({
      route: "/api/agents/intents",
      body: {
        encryptedIntentEnvelope: "t3env.safe.ciphertext",
        asset: "SHOULD_NOT_LEAK",
        side: "SHOULD_NOT_LEAK",
        quantity: "SHOULD_NOT_LEAK",
        price: "SHOULD_NOT_LEAK",
      },
    });

    expect(redacted).toEqual({
      route: "/api/agents/intents",
      body: {
        encryptedIntentEnvelope: "t3env.safe.ciphertext",
        asset: "[REDACTED]",
        side: "[REDACTED]",
        quantity: "[REDACTED]",
        price: "[REDACTED]",
      },
    });
  });
});
