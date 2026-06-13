import type { BackendEnv } from "../../config/env.js";
import type {
  CreateInstitutionRequest,
  Institution,
} from "../../models/institution.js";
import type { AdmitAgentRequest } from "../../models/agent.js";

export const us1InstitutionId =
  "00000000-0000-4000-8000-000000000101";
export const us1OperatorInstitutionId =
  "00000000-0000-4000-8000-000000000101";
export const us1OtherInstitutionId =
  "00000000-0000-4000-8000-000000000102";
export const us1AgentDid = "did:t3n:agent:us1-authorized";

export function buildBackendTestEnv(): BackendEnv {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "https://database.invalid",
    SUPABASE_URL: "https://supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    T3N_API_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    T3N_ENV: "testnet",
    T3_NETWORK_URL: "https://t3.invalid",
    T3_TENANT_DID: "did:t3n:tenant:test",
    T3_MATCH_CONTRACT_ID: "contract:test",
    RECEIPT_KEY_VERSION: "receipt-key:test",
    SETTLEMENT_ASSET_CODE: "USDC",
  };
}

export function buildCreateInstitutionRequest(
  overrides: Partial<CreateInstitutionRequest> = {},
): CreateInstitutionRequest {
  return {
    legalName: "Northstar Capital Markets LLC",
    displayName: "Northstar Capital",
    settlementProfileRef: "settlement-profile:northstar:test",
    metadata: { environment: "test" },
    ...overrides,
  };
}

export function buildInstitution(
  overrides: Partial<Institution> = {},
): Institution {
  return {
    id: us1InstitutionId,
    legalName: "Northstar Capital Markets LLC",
    displayName: "Northstar Capital",
    status: "active",
    t3TenantDid: "did:t3n:tenant:northstar",
    settlementProfileRef: "settlement-profile:northstar:test",
    metadata: { environment: "test" },
    ...overrides,
  };
}

export function buildAdmitAgentRequest(
  overrides: Partial<AdmitAgentRequest> = {},
): AdmitAgentRequest {
  return {
    institutionId: us1OperatorInstitutionId,
    agentDid: us1AgentDid,
    authorityProof: "proof:dashboard-grant",
    ...overrides,
  };
}
