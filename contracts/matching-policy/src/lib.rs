//! GhostBroker matching TEE contract.
//!
//! Two exports:
//!   - `seal-intent`    — mints an opaque intent handle + execution ref
//!                        for a sealed blind intent.
//!   - `evaluate-match` — decides whether a (buy, sell) intent pair
//!                        crosses, and if so at what fill quantity and
//!                        execution price, then returns an opaque match
//!                        outcome the orchestrator settles on.
//!
//! As of v0.2.0, match authority lives inside the enclave: the caller
//! sends both sides' asset code, prices, and quantities, and the
//! contract returns `status: "matched"` with `matched_quantity` and
//! `execution_price` only when the buyer's bid crosses the seller's
//! ask. The backend orchestrator is a verifier/orchestrator around
//! the enclave outcome, not the price matcher. The functions stay
//! pure and deterministic — no new enclave state is required.

#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
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

pub const CONTRACT_VERSION: &str = "0.2.0";

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::ghostbroker::matching_policy::contracts::Guest for Component {
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
    /// Buy/sell prices and quantities, carried as decimal strings so
    /// the contract parses them into exact `u128` integers. JSON
    /// numbers may be IEEE-754 doubles on some hosts; rounding them
    /// would make the midpoint non-deterministic, so the wire form
    /// is always a string.
    pub buy_price: String,
    pub buy_quantity: String,
    pub sell_price: String,
    pub sell_quantity: String,
}

#[derive(Debug, Serialize)]
pub struct EvaluateMatchOutput {
    pub outcome_ref: String,
    pub execution_ref: String,
    pub buyer_institution_id: String,
    pub seller_institution_id: String,
    pub encrypted_trade_fields_ref: String,
    pub buyer_authority_ref: String,
    pub seller_authority_ref: String,
    pub expires_at: String,
    pub status: String,
    /// Filled quantity = `min(buy_quantity, sell_quantity)` when the
    /// pair crosses. Emitted as a decimal string so the backend
    /// parses it without float drift. Empty on `no_match`.
    pub matched_quantity: String,
    /// Execution price = deterministic midpoint of the buy and sell
    /// prices, rounded half-up on the smallest unit. Emitted as a
    /// decimal string. Empty on `no_match`.
    pub execution_price: String,
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
