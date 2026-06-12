import type { BackendEnv } from "../../config/env.js";
import type { HiddenIntentRequest } from "../../models/hidden-intent.js";

export const us2InstitutionId = "00000000-0000-4000-8000-000000000201";
export const us2AgentDid = "did:t3n:agent:us2-authorized";
export const us2AuthorityRef = "authority:us2:intent-submit";
export const us2EncryptedEnvelope =
  "t3env.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ciphertext";

export function buildBackendTestEnv(
  overrides: Partial<BackendEnv> = {},
): BackendEnv {
  return {
    NODE_ENV: "test",
    PORT: 3001,
    CORS_ALLOWED_ORIGINS: "",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    DATABASE_URL: "",
    T3N_API_KEY: "test-key",
    T3N_ENV: "testnet",
    T3_NETWORK_URL: "",
    T3_TENANT_DID: "did:t3n:institution:us2",
    T3_MATCH_CONTRACT_ID: "match-contract-us2",
    RECEIPT_KEY_VERSION: "receipt-key-v1",
    ...overrides,
  };
}

export function buildHiddenIntentRequest(
  overrides: Partial<HiddenIntentRequest> = {},
): HiddenIntentRequest {
  return {
    institutionId: us2InstitutionId,
    agentDid: us2AgentDid,
    encryptedIntentEnvelope: us2EncryptedEnvelope,
    authorityRef: us2AuthorityRef,
    ...overrides,
  };
}
