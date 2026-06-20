//! GhostBroker matching TEE contract.
//!
//! Four exports:
//!   - `seal-ticket`    — mints an opaque ticket handle + execution
//!                        ref for a sealed negotiation ticket. The
//!                        handle is bound to every input field
//!                        including `policy_hash` and
//!                        `compatibility_token`, so a different
//!                        token produces a different handle.
//!   - `seal-intent`    — mints an opaque intent handle + execution
//!                        ref for a sealed blind intent.
//!   - `evaluate-match` — decides whether a (buy, sell) intent
//!                        pair crosses, and if so at what fill
//!                        quantity and execution price, then
//!                        returns an opaque match outcome the
//!                        orchestrator settles on.
//!   - `evaluate-pair`  — structural pair authority for
//!                        negotiation tickets. The orchestrator
//!                        owns the in-memory pending queue but
//!                        must call this function before pairing;
//!                        the TEE returns `compatible` only when
//!                        both sides' ticket handles are
//!                        well-formed, both compatibility tokens
//!                        parse to a (asset, side, institution)
//!                        tuple, and every structural axis
//!                        (same asset, opposite side, different
//!                        institution, distinct handles) agrees.
//!
//! As of v0.7.0, the wire form for prices and quantities on
//! `evaluate-match` is a plain decimal string at the contract's
//! internal `WIRE_SCALE` (1e18): `"0.0001"`, `"70000"`,
//! `"12345.6789"`. Match authority still lives inside the
//! enclave: the caller sends both sides' asset code, prices, and
//! quantities, and the contract returns `status: "matched"` with
//! `matched_quantity` and `execution_price` (also in the same
//! human-readable decimal form) only when the buyer's bid
//! crosses the seller's ask. The backend orchestrator is a
//! verifier/orchestrator around the enclave outcome, not the
//! price matcher. The functions stay pure and deterministic —
//! no new enclave state is required.
//!
//! v0.6.0 changes:
//!   * `seal-ticket` now binds `policy_hash` and
//!     `compatibility_token` into the ticket handle (previously
//!     the Rust code reserved capacity for them but never wrote
//!     the bytes; the handle was effectively a hash of
//!     `(institution_id, agent_did, authority_ref, asset_code,
//!     side, correlation_ref)` only).
//!   * New export `evaluate-pair` makes the TEE the structural
//!     pair authority for negotiation tickets. The orchestrator
//!     still owns the in-memory pending queue but must call
//!     `evaluate-pair` before creating a session; the TEE returns
//!     `status: "compatible"` only when every structural axis
//!     agrees (handle well-formedness, asset agreement, opposite
//!     side, different institution, distinct handles).
//!
//! v0.7.0 changes (audit-trail fix for the orchestrator's
//! silent overwrites of the buyer/seller institution IDs and
//! authority refs on the match outcome):
//!   * `evaluate-match` now requires the orchestrator to pass
//!     `buy_institution_id`, `sell_institution_id`,
//!     `buy_authority_ref`, `sell_authority_ref` on every call.
//!     These are the values the orchestrator already has in its
//!     pending-intent queue (the same values the seal call
//!     accepted at submit time). The TEE no longer returns empty
//!     strings — it echoes the supplied identity fields on both
//!     `matched` and `no_match` outcomes, so the audit log
//!     carries a TEE-attested match outcome instead of an
//!     orchestrator-stamped override. The orchestrator asserts
//!     the echo matches the queue values it submitted and fails
//!     closed on mismatch (poisoned queue, lost binding, TEE
//!     returning different values).
//!   * `evaluate-match` now also returns `match_attestation_ref`:
//!     a deterministic SHA-256 over the canonical concatenation
//!     of (buy_intent_handle, buy_institution_id,
//!     sell_intent_handle, sell_institution_id, buy_authority_ref,
//!     sell_authority_ref, correlation_ref, asset_code,
//!     outcome_ref, execution_ref). Anyone with the input fields
//!     and the outcome/execution refs can re-derive the
//!     attestation and confirm the recorded institution IDs are
//!     the IDs the TEE bound to the match outcome. The
//!     settlement record stores this ref so a judge reading the
//!     completed_trades row can verify the institution IDs in
//!     the row are the IDs the TEE bound to the match outcome.

#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use sha2::{Digest, Sha256};

wit_bindgen::generate!({
    world: "contract",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

mod matching;

pub const CONTRACT_VERSION: &str = "0.7.0";

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::ghostbroker::matching_policy::contracts::Guest for Component {
    fn seal_ticket(
        req: exports::ghostbroker::matching_policy::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let input = req
            .input
            .ok_or_else(|| "seal-ticket: missing input bytes".to_string())?;
        matching::seal_ticket(&input)
    }

    fn seal_intent(
        req: exports::ghostbroker::matching_policy::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let input = req
            .input
            .ok_or_else(|| "seal-intent: missing input bytes".to_string())?;
        matching::seal_intent(&input)
    }

    fn evaluate_match(
        req: exports::ghostbroker::matching_policy::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let input = req
            .input
            .ok_or_else(|| "evaluate-match: missing input bytes".to_string())?;
        matching::evaluate_match(&input)
    }

    fn evaluate_pair(
        req: exports::ghostbroker::matching_policy::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let input = req
            .input
            .ok_or_else(|| "evaluate-pair: missing input bytes".to_string())?;
        matching::evaluate_pair(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

// ─── Public input/output shapes (JSON over the generic-input envelope) ───

// ─── Outer envelope shape ───

/// The T3 host marshals a contract call's body into a
/// `host:tenant/generic-input` envelope whose `input` field
/// holds the raw JSON bytes the contract is expected to
/// parse. We receive that envelope as a `GenericInput`
/// record from `wit-bindgen`, then unwrap the inner `input`
/// bytes here before JSON-decoding into the strongly-typed
/// `SealIntentInput` / `EvaluateMatchInput` shape.
///
/// This is a structural mirror of the procurement-policy
/// contract's `evaluate_purchase` flow: the host gives us
/// the body as bytes, we parse the body as JSON.
#[derive(Debug, Deserialize)]
pub struct OuterEnvelope {
    pub input: Option<String>,
    #[serde(rename = "user-profile", default)]
    pub user_profile: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SealTicketInput {
    pub institution_id: String,
    pub agent_did: String,
    pub authority_ref: String,
    pub asset_code: String,
    pub side: String,
    pub policy_hash: String,
    pub compatibility_token: String,
    pub correlation_ref: String,
}

#[derive(Debug, Serialize)]
pub struct SealTicketOutput {
    pub ticket_handle: String,
    pub execution_ref: String,
}

#[derive(Debug, Deserialize)]
pub struct SealIntentInput {
    pub institution_id: String,
    pub agent_did: String,
    pub encrypted_intent: String,
    pub authority_ref: String,
    pub correlation_ref: String,
}

#[derive(Debug, Serialize)]
pub struct SealIntentOutput {
    pub intent_handle: String,
    pub execution_ref: String,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateMatchInput {
    pub buy_intent_handle: String,
    pub sell_intent_handle: String,
    pub correlation_ref: String,
    /// Shared traded asset code (e.g. "WBTC"). Both sides must be on
    /// the same instrument; the orchestrator already filters this, but
    /// the enclave checks it too so a mismatch is a `no_match`, not a
    /// silent cross-asset fill.
    pub asset_code: String,
    /// Buy/sell prices and quantities, carried as plain decimal
    /// strings at the contract's implicit `WIRE_SCALE` (1e18):
    /// `"0.0001"`, `"70000"`, `"12345.6789"`. JSON numbers may
    /// be IEEE-754 doubles on some hosts; rounding them would make
    /// the midpoint non-deterministic, so the wire form is always
    /// a decimal string the contract parses into an exact scaled
    /// `u128` internally.
    pub buy_price: String,
    pub buy_quantity: String,
    pub sell_price: String,
    pub sell_quantity: String,
    /// Per-side identity fields. Required on every `evaluate-match`
    /// call as of v0.7.0. The orchestrator already holds these in
    /// its pending-intent queue (they were verified at seal time
    /// via `seal-intent`'s `institution_id` / `authority_ref`).
    /// The TEE echoes them back on both `matched` and `no_match`
    /// outcomes and binds them to the `match_attestation_ref` so
    /// the audit log carries a TEE-attested identity instead of an
    /// orchestrator-stamped override. A `matched` call that omits
    /// any of these is a hard error — the TEE refuses to fill
    /// without a complete identity binding.
    pub buy_institution_id: String,
    pub sell_institution_id: String,
    pub buy_authority_ref: String,
    pub sell_authority_ref: String,
}

#[derive(Debug, Serialize)]
pub struct EvaluateMatchOutput {
    pub outcome_ref: String,
    pub execution_ref: String,
    /// Echoed `buy_institution_id` from the input. The TEE is the
    /// binding authority on this value as of v0.7.0 — the audit
    /// log records this string as the buyer institution for the
    /// outcome, not the orchestrator's in-memory queue value.
    /// Empty only when the caller submitted empty on a `no_match`
    /// (the TEE does not synthesize an identity it was not given).
    pub buyer_institution_id: String,
    /// Echoed `sell_institution_id` from the input.
    pub seller_institution_id: String,
    pub encrypted_trade_fields_ref: String,
    /// Echoed `buy_authority_ref` from the input.
    pub buyer_authority_ref: String,
    /// Echoed `sell_authority_ref` from the input.
    pub seller_authority_ref: String,
    pub expires_at: String,
    pub status: String,
    /// Filled quantity = `min(buy_quantity, sell_quantity)` when the
    /// pair crosses. Emitted at the wire's natural decimal scale
    /// (`"0.0001"`, `"4"`) so the backend and the settlement rail
    /// consume it without re-scaling. Empty on `no_match`.
    pub matched_quantity: String,
    /// Execution price = deterministic midpoint of the buy and sell
    /// prices, rounded half-up on the smallest unit. Emitted at the
    /// same wire scale as the input (`"50000"`). Empty on `no_match`.
    pub execution_price: String,
    /// Deterministic SHA-256 attestation binding the match outcome
    /// to the supplied identity. Computed as
    /// `SHA-256(buy_intent_handle || buy_institution_id ||
    /// sell_intent_handle || sell_institution_id ||
    /// buy_authority_ref || sell_authority_ref || correlation_ref
    /// || asset_code || outcome_ref || execution_ref)`. Anyone with
    /// the input fields and the outcome/execution refs can
    /// re-derive the attestation and confirm the recorded
    /// institution IDs are the ones the TEE bound to the match
    /// outcome. The settlement record stores this ref so a judge
    /// reading the `completed_trades` row can verify the
    /// institution IDs in the row are the IDs the TEE bound to
    /// the match outcome.
    pub match_attestation_ref: String,
}

// ─── evaluate-pair types (negotiation ticket pair authority) ───
//
// The pair decision is a structural check: both ticket handles
// are well-formed, both compatibility tokens parse to a
// (asset, side, institution) tuple, and the two sides agree on
// the structural axes. The TEE is stateless and pure, so it does
// not remember which tickets it has actually sealed; the
// orchestrator is responsible for passing real handles from a
// real `seal-ticket` call. The TEE enforces the shape of the
// attestation, not the authenticity of the handle itself.

#[derive(Debug, Deserialize)]
pub struct EvaluatePairInput {
    /// Ticket handle returned by `seal-ticket` for the buy side.
    /// Must match `^ticket_[0-9a-f]{32}$` exactly.
    pub buy_ticket_handle: String,
    /// Ticket handle returned by `seal-ticket` for the sell side.
    /// Must match `^ticket_[0-9a-f]{32}$` exactly.
    pub sell_ticket_handle: String,
    /// Compatibility token submitted to `seal-ticket` for the
    /// buy side: `<asset>:<side>:<institution-id>`. The TEE
    /// parses it back into the three components and uses them
    /// for the structural compatibility check.
    pub buy_compatibility_token: String,
    /// Compatibility token submitted to `seal-ticket` for the
    /// sell side.
    pub sell_compatibility_token: String,
    /// Shared traded asset code (e.g. `"WBTC"`). The TEE
    /// cross-checks this against the asset component of each
    /// compatibility token.
    pub asset_code: String,
    pub correlation_ref: String,
}

#[derive(Debug, Serialize)]
pub struct EvaluatePairOutput {
    /// Deterministic pair identifier: SHA-256 over the
    /// lexically-sorted handles + asset code. Same pair → same
    /// `pair_ref` across retries.
    pub pair_ref: String,
    pub execution_ref: String,
    /// `"compatible"` when every structural axis agrees,
    /// `"incompatible"` when any check fails.
    pub status: String,
    /// Human-readable reason for the decision. Empty on
    /// `compatible`; non-empty on `incompatible`.
    pub reason: String,
    /// Stable machine-readable reason code. Empty on
    /// `compatible`; one of `same_institution`, `asset_mismatch`,
    /// `malformed_*_ticket_handle`, `malformed_*_compatibility_token`,
    /// `*_token_wrong_side`, `*_token_asset_mismatch`, `self_pair`,
    /// `missing_*` on `incompatible`.
    pub reason_code: String,
    /// Echo of the buy ticket handle, even on `incompatible`,
    /// so the orchestrator's audit log can correlate.
    pub buy_ticket_handle: String,
    pub sell_ticket_handle: String,
    /// Extracted from the buy compatibility token. Empty on
    /// `incompatible` if the token did not parse.
    pub buy_institution_id: String,
    pub sell_institution_id: String,
    pub asset_code: String,
    /// 5-minute window — the orchestrator creates the session
    /// row immediately, but a transient DB error on the
    /// orchestrator side can retry the `evaluate-pair` call and
    /// the deduped `pair_ref` + `expires_at` is what it uses to
    /// detect the retry.
    pub expires_at: String,
}

// ─── Shared helpers ───

/// First 16 bytes of SHA-256(input) → 32-char lowercase hex.
/// Stable, deterministic, collision-resistant for the
/// orchestrator's in-memory queue keys. Same construction
/// the procurement-policy contract uses for any derived id.
fn hex_handle(prefix: &str, input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        hex.push_str(&format!("{:02x}", byte));
    }
    format!("{}_{}", prefix, &hex[..32])
}

/// Fresh execution ref. v4 UUIDs in the same shape the
/// t3-enclave `T3BlindIntentClient` and `T3MatchContractClient`
/// fall back to when the upstream T3N response omits the
/// field — `t3exec_<uuid>`.
fn fresh_execution_ref() -> String {
    // Avoid pulling in the `uuid` crate (and its getrandom
    // dependency, which doesn't link cleanly into a
    // no_std Wasm32 target). A v4-shaped string of 32 hex
    // chars from two SHA-256 invocations is more than
    // sufficient for a per-call execution identifier.
    let mut hasher = Sha256::new();
    hasher.update(b"matching-policy:exec:");
    hasher.update(matching::monotonic_nonce().to_be_bytes());
    let first = hasher.finalize();
    let mut hasher = Sha256::new();
    hasher.update(b"matching-policy:exec2:");
    hasher.update(matching::monotonic_nonce().to_be_bytes());
    let second = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for byte in first.iter().take(8) {
        hex.push_str(&format!("{:02x}", byte));
    }
    for byte in second.iter().take(8) {
        hex.push_str(&format!("{:02x}", byte));
    }
    format!("t3exec_{}", hex)
}
