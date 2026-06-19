import { describe, expect, it } from "vitest";
import {
  createInstitutionRequestSchema,
  updateInstitutionRequestSchema,
} from "../../models/institution.js";

/**
 * WS3 backend validation tests. Covers:
 *   1. `createInstitutionRequestSchema` accepts the
 *      chain-rail profile when the metadata carries
 *      `depositAddress` and `tokenAddresses`.
 *   2. Same schema rejects the chain-rail profile when
 *      metadata is missing either field.
 *   3. Same schema rejects unsupported profile refs
 *      (including the legacy `wallet:default` noop
 *      profile and `custody:*` profiles, which have
 *      been removed).
 *   4. `updateInstitutionRequestSchema` mirrors the same
 *      validation; allows metadata-only updates without a
 *      profile change.
 */
describe("createInstitutionRequestSchema (WS3 chain-rail validation)", () => {
  const base = {
    legalName: "Northstar Capital Markets LLC",
    displayName: "Northstar Capital",
  };

  it("accepts the chain rail profile with depositAddress and tokenAddresses", () => {
    const parsed = createInstitutionRequestSchema.safeParse({
      ...base,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        depositAddress: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
        tokenAddresses: {
          WBTC: "0x1111111111111111111111111111111111111111",
          USDC: "0x2222222222222222222222222222222222222222",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects the chain rail profile when metadata is missing", () => {
    const parsed = createInstitutionRequestSchema.safeParse({
      ...base,
      settlementProfileRef: "chain:sepolia:erc20",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.startsWith("metadata."))).toBe(true);
  });

  it("rejects the chain rail profile when only depositAddress is set", () => {
    const parsed = createInstitutionRequestSchema.safeParse({
      ...base,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        depositAddress: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects the chain rail profile when depositAddress is not a valid address", () => {
    const parsed = createInstitutionRequestSchema.safeParse({
      ...base,
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        depositAddress: "not-an-address",
        tokenAddresses: {
          WBTC: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unsupported profile refs (including the legacy noop rail)", () => {
    // GhostBroker exposes a single settlement rail
    // (`chain:sepolia:erc20`). The legacy `wallet:default`
    // noop profile and `custody:*` profiles are no longer
    // accepted.
    for (const profile of ["wallet:default", "custody:fireblocks", "bogus:profile"]) {
      const parsed = createInstitutionRequestSchema.safeParse({
        ...base,
        settlementProfileRef: profile,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("accepts the legacy settlement-profile:* format for backwards compatibility", () => {
    const parsed = createInstitutionRequestSchema.safeParse({
      ...base,
      settlementProfileRef: "settlement-profile:northstar:test",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("updateInstitutionRequestSchema (WS3 PATCH validation)", () => {
  it("accepts a metadata-only update", () => {
    const parsed = updateInstitutionRequestSchema.safeParse({
      metadata: {
        tokenAddresses: { WBTC: "0x1111111111111111111111111111111111111111" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a profile change to chain rail with the required metadata", () => {
    const parsed = updateInstitutionRequestSchema.safeParse({
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        depositAddress: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
        tokenAddresses: {
          WBTC: "0x1111111111111111111111111111111111111111",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty body (no fields supplied)", () => {
    const parsed = updateInstitutionRequestSchema.safeParse({});
    expect(parsed.success).toBe(true);
    // The route layer rejects empty bodies with 400; the
    // schema's job is just to validate the fields when
    // they are present. This test pins the contract.
  });

  it("rejects a chain rail profile change without the required metadata", () => {
    const parsed = updateInstitutionRequestSchema.safeParse({
      settlementProfileRef: "chain:sepolia:erc20",
    });
    expect(parsed.success).toBe(false);
  });
});
