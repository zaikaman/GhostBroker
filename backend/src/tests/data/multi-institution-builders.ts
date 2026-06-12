export const unrelatedInstitutionId =
  "00000000-0000-4000-8000-000000000202";
export const participantInstitutionId =
  "00000000-0000-4000-8000-000000000203";

export function buildInstitutionPair(): {
  participantInstitutionId: string;
  unrelatedInstitutionId: string;
} {
  return {
    participantInstitutionId,
    unrelatedInstitutionId,
  };
}
