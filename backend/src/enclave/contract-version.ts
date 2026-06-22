/**
 * The single source of truth for the T3 TEE contract version the
 * backend pins on every cross-contract call body.
 *
 * Every T3 client (`T3MatchContractClient`, `T3NegotiationTicketClient`,
 * `T3NegotiationRoundClient`) reads this constant as its default so
 * bumping the published contract's version is a single edit here
 * plus the corresponding `T3_MATCHING_CONTRACT_VERSION` env var
 * that `app.ts` forwards into the client constructors. The Rust
 * `Cargo.toml` + `lib.rs` version constants stay in lockstep.
 *
 * Bump this and `Cargo.toml` together when you ship a new
 * TEE contract build. The convention is:
 *   - patch bump - wire-shape change that does not affect
 *     the orchestrator's interpretation of the response,
 *   - minor bump - new exported function (v0.9.0
 *     introduced `seal-round-proposal` + `evaluate-round`;
 *     v0.9.1 added in-enclave AEAD decryption for both
 *     `seal-intent` and `seal-round-proposal`; v0.10.0 added
 *     `host:interfaces/kv-store` - the enclave now persists
 *     decrypted price/quantity inside the TEE and the
 *     orchestrator never holds or forwards plaintext; v0.13.0
 *     fixed kv-store map names to use canonical `z:<tenant>:<tail>`
 *     form - the host does not auto-prefix the tenant namespace;
 *     v0.14.0 added SDK-native delegation envelope support -
 *     per-agent calls (`seal-ticket`, `seal-intent`,
 *     `seal-round-proposal`) now accept an optional
 *     `delegation_envelope` field and the TEE verifies the
 *     credential authorises the called function; v0.15.1 added
 *     `logging::audit` emission on every contract execution so
 *     the tenant audit trail is populated via `getAuditEvents`),
 *   - major bump - response field removed or renamed.
 */
export const DEFAULT_CONTRACT_VERSION = "0.15.1";
