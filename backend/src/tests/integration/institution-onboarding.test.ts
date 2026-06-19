import { describe, expect, it } from "vitest";
import type { TenantDidRegistry } from "../../enclave/index.js";
import {
  InstitutionService,
  type InstitutionRepository,
} from "../../services/institution.service.js";
import {
  buildCreateInstitutionRequest,
  buildInstitution,
} from "../data/us1-seed-builders.js";

describe("institution onboarding", () => {
  it("resolves the tenant DID through T3 before writing the institution", async () => {
    const didRegistry: TenantDidRegistry = {
      resolveOrRegisterTenantDid: async () => ({
        tenantDid: "did:t3n:tenant:resolved",
        source: "existing_session",
      }),
    };
    const repository: InstitutionRepository = {
      createInstitution: async (value) =>
        buildInstitution({
          t3TenantDid: value.t3TenantDid,
          settlementProfileRef: value.settlementProfileRef,
        }),
      findByTenantDid: async () => null,
      findById: async () => null,
    };
    const service = new InstitutionService(repository, didRegistry);

    const institution = await service.createInstitution(
      buildCreateInstitutionRequest(),
    );

    expect(institution.t3TenantDid).toBe("did:t3n:tenant:resolved");
    expect(institution.settlementProfileRef).toBe(
      "settlement-profile:northstar:test",
    );
  });
});
