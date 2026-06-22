import type { BackendEnv } from "../../config/env.js";
import type { HiddenIntentRequest } from "../../models/hidden-intent.js";
import { loadEnvelopeMasterKey, sealEnvelope, type EnvelopeMasterKey } from "../../enclave/keys/envelope-cipher.js";
import { TEST_AUTH_SESSION_SECRET } from "./us1-seed-builders.js";

export { TEST_AUTH_SESSION_SECRET };

export const us2InstitutionId = "00000000-0000-4000-8000-000000000201";
export const us2AgentId = "00000000-0000-4000-8000-000000000a01";
export const us2AgentDid = "did:t3n:agent:us2-authorized";
export const us2AuthorityRef = "authority:us2:intent-submit";

/**
 * The 32-byte test AEAD master key. All test builders and
 * fixture envelopes share this key so the AEAD round-trip
 * works in-process; production code resolves the master key
 * via `loadEnvelopeMasterKey` from the
 * `ENVELOPE_ENCRYPTION_MASTER_KEY` env var (32 bytes hex).
 *
 * The value is hard-coded here AND mirrored in
 * `backend/vitest.config.ts` as `TEST_ENVELOPE_MASTER_KEY`
 * so the orchestrator's `decodeSealedEnvelope` fallback (which
 * reads `process.env`) sees the same master key the producer
 * sealed with.
 */
const TEST_MASTER_KEY_HEX =
  "a4f1c2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
process.env["ENVELOPE_ENCRYPTION_MASTER_KEY"] ??= TEST_MASTER_KEY_HEX;
let cachedTestMasterKey: EnvelopeMasterKey | undefined;
function testMasterKey(): EnvelopeMasterKey {
  if (cachedTestMasterKey) {
    return cachedTestMasterKey;
  }
  cachedTestMasterKey = loadEnvelopeMasterKey({
    ENVELOPE_ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY_HEX,
  });
  return cachedTestMasterKey;
}

/**
 * The legacy placeholder string the older hidden-intent tests
 * referenced. Replaced by the AEAD builder below; kept as a
 * stable export only for tests that need to assert the column
 * is no longer the raw envelope.
 */
export const us2EncryptedEnvelope =
  "t3env.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ciphertext";

/**
 * Build an AEAD-sealed envelope for tests. The envelope is a
 * real AES-256-GCM ciphertext with the per-institution key
 * derived from the test master key; the orchestrator-side
 * `decodeSealedEnvelope` round-trips it back to the structured
 * payload on the in-process test path.
 */
function buildSealedEnvelopePayload(
  institutionDid: string,
  agentDid: string,
  authorityRef: string,
  assetCode: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
  nonce = "nonce-test",
): string {
  return sealEnvelope({
    institutionDid,
    agentDid,
    authorityRef,
    payload: {
      institutionId: institutionDid,
      agentDid,
      authorityRef,
      assetCode,
      side,
      quantity,
      price,
      nonce,
    },
    masterKey: testMasterKey(),
  });
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
    T3_MATCHING_CONTRACT_VERSION: "0.14.0",
    RECEIPT_KEY_VERSION: "receipt-key-v1",
    SETTLEMENT_ASSET_CODE: "USDC",
    AUTH_SESSION_SECRET:
      "test-auth-session-secret-with-at-least-thirty-two-characters",
    ENVELOPE_ENCRYPTION_MASTER_KEY: TEST_MASTER_KEY_HEX,
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
    encryptedIntentEnvelope: buildSealedEnvelopePayload(
      us2InstitutionId,
      us2AgentDid,
      us2AuthorityRef,
      "WBTC",
      "buy",
      100,
      47000,
    ),
    authorityRef: us2AuthorityRef,
    ...overrides,
  };
}

export function buildHiddenIntentRequestForSide(
  side: "buy" | "sell",
  overrides: Partial<HiddenIntentRequest> = {},
): HiddenIntentRequest {
  const institutionId =
    side === "buy"
      ? "00000000-0000-4000-8000-000000000211"
      : "00000000-0000-4000-8000-000000000212";
  const agentId =
    side === "buy"
      ? "00000000-0000-4000-8000-000000000b01"
      : "00000000-0000-4000-8000-000000000b02";
  const agentDid =
    side === "buy"
      ? "did:t3n:agent:buyer-us2"
      : "did:t3n:agent:seller-us2";
  return buildHiddenIntentRequest({
    institutionId,
    agentId,
    agentDid,
    encryptedIntentEnvelope: buildSealedEnvelopePayload(
      institutionId,
      agentDid,
      us2AuthorityRef,
      "WBTC",
      side,
      100,
      side === "buy" ? 47000 : 43000,
    ),
    ...overrides,
  });
}

/**
 * Test-only helper: build an AEAD-sealed envelope from
 * arbitrary inputs without touching the HiddenIntentRequest
 * default values. Exposed so integration tests can mint a
 * deterministic envelope that round-trips through
 * `decodeSealedEnvelope`.
 */
export function sealTestEnvelope(input: {
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  nonce?: string | undefined;
}): string {
  return sealEnvelope({
    institutionDid: input.institutionDid,
    agentDid: input.agentDid,
    authorityRef: input.authorityRef,
    payload: {
      institutionId: input.institutionDid,
      agentDid: input.agentDid,
      authorityRef: input.authorityRef,
      assetCode: input.assetCode,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    },
    masterKey: testMasterKey(),
  });
}

/** Test-only helper: the deterministic AEAD master key. */
export function getTestEnvelopeMasterKey(): EnvelopeMasterKey {
  return testMasterKey();
}
