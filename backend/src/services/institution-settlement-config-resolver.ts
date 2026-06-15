import type { InstitutionRepository } from "./institution.service.js";
import type {
  InstitutionSettlementConfig,
  InstitutionSettlementConfigResolver,
} from "./settlement.service.js";

/**
 * Production resolver: looks up the per-institution
 * `settlement_profile_ref` and `metadata` from the existing
 * `InstitutionRepository`. The rail layer treats the metadata
 * as a generic `Record<string, unknown>`; the chain rail reads
 * `depositAddress` and `tokenAddresses`, the noop rail reads
 * nothing.
 *
 * The resolver is intentionally narrow: it returns null for
 * unknown institutions so the settlement service can fall back
 * to the noop rail's hard-coded default rather than throwing.
 * Production callers that need strict 404 semantics should
 * wrap this resolver and throw if the institution is missing.
 */
export class RepositoryInstitutionSettlementConfigResolver
  implements InstitutionSettlementConfigResolver
{
  public constructor(private readonly repository: InstitutionRepository) {}

  public async resolve(
    institutionId: string,
  ): Promise<InstitutionSettlementConfig | null> {
    const institution = await this.repository.findById(institutionId);
    if (!institution) {
      return null;
    }
    return {
      settlementProfileRef: institution.settlementProfileRef,
      metadata: institution.metadata,
    };
  }
}
