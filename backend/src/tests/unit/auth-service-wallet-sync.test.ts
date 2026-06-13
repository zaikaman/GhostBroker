import type { AgentIdentityVerifier } from "@ghostbroker/t3-enclave";
import { describe, expect, it } from "vitest";
import type { AuthInstitutionRepository } from "../../services/auth.service.js";
import { DidAuthService } from "../../services/auth.service.js";

describe("DidAuthService wallet auth", () => {
  it("creates institution and issues session with connected wallet metadata", async () => {
    const createdInstitutions: Array<{
      legalName: string;
      displayName: string;
      settlementProfileRef: string;
      t3TenantDid: string;
      metadata: Readonly<Record<string, unknown>>;
    }> = [];

    const institutions: AuthInstitutionRepository = {
      findByTenantDid: async () => null,
      createInstitution: async (value) => {
        createdInstitutions.push(value);
        return {
          id: "00000000-0000-4000-8000-000000000701",
          legalName: value.legalName,
          displayName: value.displayName,
          status: "active",
          t3TenantDid: value.t3TenantDid,
          settlementProfileRef: value.settlementProfileRef,
          metadata: value.metadata,
        };
      },
    };



    const identityVerifier = {
      verifyAgentIdentity: async () => ({
        status: "verified",
        did: "did:t3:0x1111111111111111111111111111111111111111",
        walletAddress: "0x1111111111111111111111111111111111111111",
      }),
    } as AgentIdentityVerifier;

    const authService = new DidAuthService({
      institutions,
      identityVerifier,
      sessionSecret: "development-only-auth-session-secret-change-before-production",
    });

    const challenge = await authService.createChallenge(
      "did:t3:0x1111111111111111111111111111111111111111",
    );

    const session = await authService.verifyChallenge({
      challengeId: challenge.challengeId,
      did: "did:t3:0x1111111111111111111111111111111111111111",
      signature: "0xsignature",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(session.institution.id).toBe("00000000-0000-4000-8000-000000000701");
    expect(createdInstitutions[0]?.metadata).toMatchObject({
      source: "wallet_auth",
      type: "self_registered",
      connectedWalletAddress: "0x1111111111111111111111111111111111111111",
    });
  });
});