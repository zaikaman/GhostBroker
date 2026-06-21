import type { BackendEnv } from "../../config/env.js";
import type { HiddenIntentRequest } from "../../models/hidden-intent.js";
import { TEST_AUTH_SESSION_SECRET } from "./us1-seed-builders.js";

export { TEST_AUTH_SESSION_SECRET };

export const us2InstitutionId = "00000000-0000-4000-8000-000000000201";
export const us2AgentId = "00000000-0000-4000-8000-000000000a01";
export const us2AgentDid = "did:t3n:agent:us2-authorized";
export const us2AuthorityRef = "authority:us2:intent-submit";
export const us2EncryptedEnvelope =
  "t3env.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ciphertext";

/**
 * Build a default valid envelope for tests. The envelope is a
 * base64url-encoded JSON blob tagged with the canonical
 * `ghostbroker.envelope/1` schema version. The TEE re-decodes
 * this envelope in the in-process fallback path to derive the
 * lock descriptor; the orchestrator itself never decodes it.
 */
function buildSealedEnvelopePayload(
  assetCode: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
): string {
  const json = JSON.stringify({
    v: "ghostbroker.envelope/1",
    institutionId: us2InstitutionId,
    agentDid: us2AgentDid,
    authorityRef: us2AuthorityRef,
    assetCode,
    side,
    quantity,
    price,
    nonce: "nonce-test",
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

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
    T3_MATCHING_CONTRACT_VERSION: "0.8.0",
    RECEIPT_KEY_VERSION: "receipt-key-v1",
    SETTLEMENT_ASSET_CODE: "USDC",
    AUTH_SESSION_SECRET:
      "test-auth-session-secret-with-at-least-thirty-two-characters",
    ...overrides,
  };
}

export function buildHiddenIntentRequest(
  overrides: Partial<HiddenIntentRequest> = {},
): HiddenIntentRequest {
  return {
    institutionId: us2InstitutionId,
    agentId: us2AgentId,
    agentDid: us2AgentDid,
    encryptedIntentEnvelope: us2EncryptedEnvelope,
    authorityRef: us2AuthorityRef,
    ...overrides,
  };
}

export function buildHiddenIntentRequestForSide(
  side: "buy" | "sell",
  overrides: Partial<HiddenIntentRequest> = {},
): HiddenIntentRequest {
  return buildHiddenIntentRequest({
    institutionId:
      side === "buy"
        ? "00000000-0000-4000-8000-000000000211"
        : "00000000-0000-4000-8000-000000000212",
    agentId:
      side === "buy"
        ? "00000000-0000-4000-8000-000000000b01"
        : "00000000-0000-4000-8000-000000000b02",
    agentDid:
      side === "buy"
        ? "did:t3n:agent:buyer-us2"
        : "did:t3n:agent:seller-us2",
    encryptedIntentEnvelope: buildSealedEnvelopePayload(
      "WBTC",
      side,
      100,
      side === "buy" ? 47000 : 43000,
    ),
    ...overrides,
  });
}
