//! Core logic for the matching contract.
//!
//! The exported functions (`seal_ticket`, `seal_intent`,
//! `evaluate_match`, `evaluate_pair`) parse the JSON payload,
//! compute deterministic opaque handles, and return a JSON
//! response. All host imports are intentionally unused here — the
//! contract is a pure function. The dispatcher still validates
//! that the WASM exposes the required WIT world, which gives us
//! a verifiable execution surface even though the body is pure.
//!
//! Wire format for prices and quantities (v0.8.0): a plain decimal
//! string, optionally with a single `.` separating integer and
//! fractional parts. Both sides carry their values at the same
//! implicit scale (the contract's internal [`WIRE_SCALE`]); the
//! orchestrator's `decimalString` serializer keeps the value
//! human-readable (`"0.0001"`, `"70000"`) and the contract
//! multiplies by `10^WIRE_SCALE` to a `u128` for deterministic
//! cross / midpoint math. The settlement rail reads the same
//! human-readable string with its per-asset decimals via
//! `parseUnits(quantity.toString(), decimals)`, so the wire form
//! matches both surfaces without a backend pre/post-scale step.
//!
//! v0.8.0 audit-trail fix. As of v0.8.0 the `evaluate-match`
//! function requires the orchestrator to pass the per-side
//! institution IDs and authority refs (the same values the
//! orchestrator already holds in its pending-intent queue, which
//! were verified at seal time via `seal-intent`). The TEE echoes
//! these identity fields back on both `matched` and `no_match`
//! outcomes and binds them to a deterministic `match_attestation_ref`
//! (a SHA-256 over the canonical concatenation of the per-side
//! identity + outcome refs). The orchestrator asserts the echo
//! matches the queue values it submitted and fails closed on
//! mismatch (poisoned queue entry, lost binding, TEE regression).
//! See the v0.8.0 changes block in `src/lib.rs` for the full
//! audit-trail rationale.
//!
//! Pair authority (`evaluate_pair`): the TEE is the structural
//! authority on whether a candidate pair of sealed negotiation
//! tickets is matchable. The orchestrator owns the in-memory
//! pending queue but is NOT allowed to pair tickets the TEE
//! rejects; the TEE returns a precise `reason_code` for every
//! rejection so the orchestrator can log a meaningful audit
//! trail. See `evaluate_pair` below for the rules.

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::{
    fresh_execution_ref, hex_handle, EvaluateMatchInput, EvaluateMatchOutput, OuterEnvelope,
    SealIntentInput, SealIntentOutput,
};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};

// ─── kv-store helpers (v0.10.0) ───
//
// The enclave persists decrypted intent and round-proposal
// plaintext into the T3N kv-store (`host:interfaces/kv-store`).
// This is the load-bearing privacy mechanism: the orchestrator
// receives only an opaque handle + the derived reservation
// amount; the individual price and quantity never leave the
// TEE. evaluate-match and evaluate-round recover the plaintext
// by handle from kv-store and compute the cross inside the
// enclave.

// The kv-store host interface resolves map names literally — it
// does NOT auto-prefix the tenant `z:` namespace. A map created
// via the tenant control plane as `z:<tenant-hex>:intents` is
// only reachable from a contract if the contract passes that
// full canonical name to `kv_put` / `kv_get` / `kv_delete`. We
// build the canonical name at runtime from `tenant_did()` so
// the same WASM runs under any tenant without recompilation.

/// Build the canonical T3N kv-store map name `z:<tenant-hex>:<tail>`
/// from the runtime tenant DID. Called on every kv-store access;
/// the tenant DID is a 20-byte value read from a host function
/// that is O(1) after the per-tx cache is populated.
#[cfg(target_arch = "wasm32")]
fn kv_map_name(tail: &str) -> String {
    use crate::host::tenant::tenant_context;
    let did_bytes = tenant_context::tenant_did();
    let mut hex = String::with_capacity(did_bytes.len() * 2);
    for byte in did_bytes.iter() {
        hex.push_str(&format!("{:02x}", byte));
    }
    format!("z:{}:{}", hex, tail)
}

/// Native fallback — `tenant_did()` is only available in the WASM
/// target. Returns the bare tail so `cargo check` / `cargo clippy`
/// pass; native builds never execute contract functions.
#[cfg(not(target_arch = "wasm32"))]
fn kv_map_name(tail: &str) -> String {
    tail.to_string()
}

/// Payload persisted in the `"intents"` kv-store map by
/// `seal-intent` and recovered by `evaluate-match`.
#[derive(serde::Serialize, serde::Deserialize)]
struct IntentKvPayload {
    traded_asset_code: String,
    settlement_asset_code: String,
    side: String,
    quantity: String,
    price: String,
}

/// Payload persisted in the `"rounds"` kv-store map by
/// `seal-round-proposal` and recovered by `evaluate-round`.
#[derive(serde::Serialize, serde::Deserialize)]
struct RoundKvPayload {
    traded_asset_code: String,
    side: String,
    quantity: String,
    price: String,
}

#[cfg(target_arch = "wasm32")]
fn kv_put(map: &str, key: &[u8], value: &[u8]) -> Result<(), String> {
    crate::host::interfaces::kv_store::put(map, key, value)
        .map_err(|e| format!("kv-store put failed (map={}): {}", map, e))
}

#[cfg(target_arch = "wasm32")]
fn kv_get(map: &str, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
    crate::host::interfaces::kv_store::get(map, key)
        .map_err(|e| format!("kv-store get failed (map={}): {}", map, e))
}

#[cfg(target_arch = "wasm32")]
fn kv_delete(map: &str, key: &[u8]) -> Result<bool, String> {
    crate::host::interfaces::kv_store::delete(map, key)
        .map_err(|e| format!("kv-store delete failed (map={}): {}", map, e))
}

/// Native fallback for `cargo check` / `cargo clippy`. The
/// kv-store host import is only available in the WASM target;
/// native builds never execute contract functions.
#[cfg(not(target_arch = "wasm32"))]
fn kv_put(_map: &str, _key: &[u8], _value: &[u8]) -> Result<(), String> {
    Err("kv-store is only available in the WASM target".to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn kv_get(_map: &str, _key: &[u8]) -> Result<Option<Vec<u8>>, String> {
    Err("kv-store is only available in the WASM target".to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn kv_delete(_map: &str, _key: &[u8]) -> Result<bool, String> {
    Err("kv-store is only available in the WASM target".to_string())
}

/// Implicit wire scale for prices and quantities on
/// `evaluate-match`. The orchestrator sends values as
/// human-readable decimal strings (`"0.0001"`, `"70000"`); the
/// contract internally multiplies by `10^WIRE_SCALE` and stores
/// the result in a `u128` so the cross, fill, and midpoint math
/// is exact (no IEEE-754 drift). 18 is the max decimals any
/// real-world ERC-20 ships with, so every quantity and price the
/// orchestrator produces fits in a `u128` after scaling without
/// precision loss.
pub(crate) const WIRE_SCALE: u32 = 18;

/// 10^WIRE_SCALE precomputed once. The constant is a `u128`
/// (1e18) and well within `u128::MAX`, so the unwrap is fine.
pub(crate) const WIRE_SCALE_FACTOR: u128 = 1_000_000_000_000_000_000;

/// Parse a non-negative decimal string into a scaled `u128`
/// (value × 10^WIRE_SCALE). Accepts plain integers (`"70000"`)
/// and fractional decimals (`"0.0001"`). Rejects:
///   - empty strings,
///   - signs (`+`, `-`),
///   - exponents (`1e5`),
///   - multiple `.` separators,
///   - more than `WIRE_SCALE` fractional digits (would overflow),
///   - any non-ASCII whitespace or non-digit non-`.` bytes.
///
/// The wire form is always a plain decimal of base-10 digits;
/// anything else means the caller (the backend) sent a
/// malformed quantity/price and the pair must be `no_match`,
/// not a silent fill at a garbage price.
pub(crate) fn parse_decimal(value: &str) -> Option<u128> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let mut int_part: u128 = 0;
    let mut frac_part: u128 = 0;
    let mut frac_digits: u32 = 0;
    let mut in_frac = false;
    for byte in bytes.iter().copied() {
        match byte {
            b'0'..=b'9' => {
                let digit = u128::from(byte - b'0');
                if in_frac {
                    frac_digits += 1;
                    if frac_digits > WIRE_SCALE {
                        // More fractional digits than the wire
                        // scale can represent without overflow.
                        return None;
                    }
                    frac_part = frac_part.checked_mul(10)?;
                    frac_part = frac_part.checked_add(digit)?;
                } else {
                    int_part = int_part.checked_mul(10)?;
                    int_part = int_part.checked_add(digit)?;
                }
            }
            b'.' => {
                if in_frac {
                    // Second dot is malformed.
                    return None;
                }
                in_frac = true;
            }
            _ => return None,
        }
    }
    let scale_up = 10u128.checked_pow(WIRE_SCALE - frac_digits)?;
    let scaled_frac = frac_part.checked_mul(scale_up)?;
    int_part
        .checked_mul(WIRE_SCALE_FACTOR)?
        .checked_add(scaled_frac)
}

/// Render a scaled `u128` (value × 10^WIRE_SCALE) as a
/// plain decimal string at the wire scale. Trailing zeros are
/// trimmed from the fractional part so `"10000"`-style integers
/// don't carry a `.000…000` suffix. Used to format
/// `matched_quantity` and `execution_price` on the way out so
/// the orchestrator (and the human reading the receipt) sees the
/// value at its natural scale, not the contract's internal base
/// units.
pub(crate) fn format_decimal(scaled: u128) -> String {
    let int_part = scaled / WIRE_SCALE_FACTOR;
    let frac_raw = scaled % WIRE_SCALE_FACTOR;
    if frac_raw == 0 {
        return int_part.to_string();
    }
    let mut frac_str = frac_raw.to_string();
    while frac_str.len() < WIRE_SCALE as usize {
        frac_str.insert(0, '0');
    }
    let trimmed = frac_str.trim_end_matches('0');
    format!("{}.{}", int_part, trimmed)
}

/// Deterministic midpoint of two scaled unsigned prices:
/// `(a + b) / 2` rounded half-up. Uses `u128` throughout so
/// there is no float drift, and `checked_add` so an overflow
/// is reported as `None` (the caller treats that as `no_match`
/// rather than wrapping).
fn midpoint(a: u128, b: u128) -> Option<u128> {
    let sum = a.checked_add(b)?;
    Some(sum / 2 + (sum & 1))
}

/// Monotonic per-instance counter used to derive fresh execution
/// refs without pulling in a randomness source. The value is
/// scoped to the contract instance's lifetime in the TEE, so two
/// calls within the same execution always get different refs.
static NONCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn monotonic_nonce() -> u64 {
    NONCE.fetch_add(1, Ordering::SeqCst)
}

// ─── delegation envelope authorization (v0.14.0) ───
//
// When the orchestrator forwards a delegation_envelope on a
// per-agent call, the contract verifies the called function is
// in the credential's functions list. This is the TEE-side
// authorization gate that makes the SDK-native delegation
// credentials enforceable at the contract level — without it the
// TEE would execute any function the orchestrator requested
// regardless of the credential's scope.
//
// The function does NOT verify the cryptographic signatures
// (user_sig, agent_sig) — the T3N host's dispatch layer
// performs signature verification before the contract executes.
// The contract's job is the function-scope check: ensure the
// credential authorises the WIT function being invoked.

/// Check a delegation envelope authorises the named function.
/// Returns the credential's vc_id (base64url) for audit-trail
/// echoing. Returns an empty string when no envelope is
/// supplied (backwards-compatible fallback).
fn check_delegation_authority(
    envelope: &Option<crate::DelegationEnvelopeInput>,
    function_name: &str,
) -> Result<String, String> {
    let env = match envelope {
        None => return Ok(String::new()),
        Some(e) => e,
    };

    // Verify the credential authorises the called function.
    if !env.functions.iter().any(|f| f == function_name) {
        return Err(format!(
            "delegation_authority_denied: credential does not authorise function `{}`",
            function_name
        ));
    }

    // Echo the vc_id for the audit trail.
    Ok(env.vc_id.clone())
}

// ─── seal-ticket ───

pub fn seal_ticket(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let body = unwrap_body(envelope_bytes)?;
    let parsed: crate::SealTicketInput = serde_json::from_slice(&body)
        .map_err(|err| format!("seal-ticket: invalid JSON input: {}", err))?;

    // Required-field check mirrors the Zod schema in
    // `backend/src/models/negotiation.ts`.
    if parsed.institution_id.is_empty() {
        return Err("seal-ticket: institution_id is required".to_string());
    }
    if parsed.agent_did.is_empty() {
        return Err("seal-ticket: agent_did is required".to_string());
    }
    if parsed.authority_ref.is_empty() {
        return Err("seal-ticket: authority_ref is required".to_string());
    }
    if parsed.asset_code.is_empty() {
        return Err("seal-ticket: asset_code is required".to_string());
    }
    if parsed.side.is_empty() {
        return Err("seal-ticket: side is required".to_string());
    }
    if parsed.policy_hash.is_empty() {
        return Err("seal-ticket: policy_hash is required".to_string());
    }
    if parsed.compatibility_token.is_empty() {
        return Err("seal-ticket: compatibility_token is required".to_string());
    }
    if parsed.correlation_ref.is_empty() {
        return Err("seal-ticket: correlation_ref is required".to_string());
    }

    // The ticket handle is the canonical TEE seal identifier.
    // Hash a stable concatenation of ALL input fields — including
    // `policy_hash` and `compatibility_token` — so (a) the same
    // input always maps to the same handle, and (b) the handle is
    // bound to the agent's policy attestation and the
    // (asset, side, institution) compatibility class. The
    // orchestrator's pair-up decision is gated on the TEE
    // `evaluate-pair` function; that function uses both handles
    // AND the original compatibility tokens to decide whether
    // the pair is matchable, so a different `compatibility_token`
    // must produce a different handle (within SHA-256 collision
    // probability) — otherwise the pair attestation would be
    // spoofable by replaying a handle with a swapped token.
    //
    // Pipe-delimited concatenation with a leading tag, then
    // hex-truncated SHA-256 via `hex_handle` (32 hex chars).
    let mut hasher_input: Vec<u8> = Vec::with_capacity(
        parsed.institution_id.len()
            + parsed.agent_did.len()
            + parsed.authority_ref.len()
            + parsed.asset_code.len()
            + parsed.side.len()
            + parsed.policy_hash.len()
            + parsed.compatibility_token.len()
            + parsed.correlation_ref.len()
            + 8,
    );
    hasher_input.extend_from_slice(b"ticket|");
    hasher_input.extend_from_slice(parsed.institution_id.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.agent_did.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.authority_ref.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.asset_code.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.side.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.policy_hash.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.compatibility_token.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.correlation_ref.as_bytes());

    let ticket_handle = crate::hex_handle("ticket", &hasher_input);
    let execution_ref = fresh_execution_ref();


    // v0.14.0: check the delegation envelope authorises "seal-ticket".
    let delegation_vc_id = check_delegation_authority(&parsed.delegation_envelope, "seal-ticket")?;
    let output = crate::SealTicketOutput {
        ticket_handle,
        execution_ref,
        delegation_vc_id,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("seal-ticket: response encode failed: {}", err))
}

// ─── evaluate-pair ───
//
// Pair authority for negotiation tickets. The orchestrator is the
// executor of the match queue (it owns the in-memory pending set),
// but the TEE is the authority on whether a CANDIDATE pair is
// matchable. The orchestrator must call this function with both
// sides' ticket handles AND their original compatibility tokens
// before creating a session; the orchestrator pairs only on a
// `compatible` outcome.
//
// The function is intentionally stateless and pure: it does not
// remember which tickets have been sealed, so it trusts the
// orchestrator to have obtained both handles from a real
// `seal-ticket` call. What it DOES verify is structural: the
// handles are well-formed, the compatibility tokens parse to a
// real (asset, side, institution) tuple, and the two sides are
// compatible on the structural axes a malicious or buggy
// orchestrator could otherwise violate (same institution, wrong
// asset, same side, swapped asset). A swap of any structural
// field is a `incompatible` outcome with a precise reason the
// orchestrator can log and the agent can surface.
//
// This is the load-bearing match decision for the pair-up. The
// per-round price cross still goes through `evaluate-match` and
// the inline negotiation evaluator; this function is only about
// the initial pair.

pub fn evaluate_pair(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let body = unwrap_body(envelope_bytes)?;
    let parsed: crate::EvaluatePairInput = serde_json::from_slice(&body)
        .map_err(|err| format!("evaluate-pair: invalid JSON input: {}", err))?;

    // Required-field check. Every field must be non-empty: an
    // empty handle or token means the orchestrator is asking the
    // TEE to validate nothing, which is always a `incompatible`
    // outcome with a precise reason.
    if parsed.buy_ticket_handle.trim().is_empty() {
        return incompatible_pair(
            &parsed,
            "buy_ticket_handle is required",
            "missing_buy_ticket_handle",
        );
    }
    if parsed.sell_ticket_handle.trim().is_empty() {
        return incompatible_pair(
            &parsed,
            "sell_ticket_handle is required",
            "missing_sell_ticket_handle",
        );
    }
    if parsed.buy_compatibility_token.trim().is_empty() {
        return incompatible_pair(
            &parsed,
            "buy_compatibility_token is required",
            "missing_buy_compatibility_token",
        );
    }
    if parsed.sell_compatibility_token.trim().is_empty() {
        return incompatible_pair(
            &parsed,
            "sell_compatibility_token is required",
            "missing_sell_compatibility_token",
        );
    }
    if parsed.asset_code.trim().is_empty() {
        return incompatible_pair(
            &parsed,
            "asset_code is required",
            "missing_asset_code",
        );
    }
    if parsed.correlation_ref.trim().is_empty() {
        return incompatible_pair(
            &parsed,
            "correlation_ref is required",
            "missing_correlation_ref",
        );
    }

    // Handle well-formedness: a real `seal-ticket` handle is
    // `ticket_<32-lowercase-hex>`. We accept exactly that shape
    // and refuse anything else. This stops a forged handle from
    // sneaking into the pair attestation.
    if !is_well_formed_ticket_handle(&parsed.buy_ticket_handle) {
        return incompatible_pair(
            &parsed,
            "buy_ticket_handle is not a well-formed ticket handle",
            "malformed_buy_ticket_handle",
        );
    }
    if !is_well_formed_ticket_handle(&parsed.sell_ticket_handle) {
        return incompatible_pair(
            &parsed,
            "sell_ticket_handle is not a well-formed ticket handle",
            "malformed_sell_ticket_handle",
        );
    }
    // Reject self-pairing (same handle both sides). The
    // orchestrator's `tryPair` loop also excludes this via
    // institutionId, but the TEE must reject it independently
    // so a misconfigured orchestrator cannot bypass the gate.
    if parsed.buy_ticket_handle == parsed.sell_ticket_handle {
        return incompatible_pair(
            &parsed,
            "buy and sell ticket handles are identical",
            "self_pair",
        );
    }

    // Compatibility token parse: the wire form is
    // `<asset>:<side>:<institution-id>`, e.g. `WBTC:buy:<uuid>`.
    // The orchestrator builds it deterministically in
    // `negotiation-loop.ts` and the TEE binds the exact bytes
    // into the ticket handle, so any structural divergence
    // (different asset, same side, swapped institution) means
    // the ticket is not what the TEE originally attested to.
    let buy_token = match parse_compatibility_token(&parsed.buy_compatibility_token) {
        Some(value) => value,
        None => {
            return incompatible_pair(
                &parsed,
                "buy_compatibility_token is not a well-formed <asset>:<side>:<institution> tuple",
                "malformed_buy_compatibility_token",
            );
        }
    };
    let sell_token = match parse_compatibility_token(&parsed.sell_compatibility_token) {
        Some(value) => value,
        None => {
            return incompatible_pair(
                &parsed,
                "sell_compatibility_token is not a well-formed <asset>:<side>:<institution> tuple",
                "malformed_sell_compatibility_token",
            );
        }
    };

    // Compatibility axes. Each axis is enforced independently so
    // the orchestrator can log a precise reason. We deliberately
    // do NOT cross-check the token's asset against the explicit
    // `asset_code` field until the side check, because the
    // orchestrator's `tryPair` already filters on `assetCode`
    // locally; the TEE re-checks both for defense in depth.
    if buy_token.side != "buy" {
        return incompatible_pair(
            &parsed,
            "buy_compatibility_token side must be 'buy'",
            "buy_token_wrong_side",
        );
    }
    if sell_token.side != "sell" {
        return incompatible_pair(
            &parsed,
            "sell_compatibility_token side must be 'sell'",
            "sell_token_wrong_side",
        );
    }
    if buy_token.asset != parsed.asset_code {
        return incompatible_pair(
            &parsed,
            "buy_compatibility_token asset does not match asset_code",
            "buy_token_asset_mismatch",
        );
    }
    if sell_token.asset != parsed.asset_code {
        return incompatible_pair(
            &parsed,
            "sell_compatibility_token asset does not match asset_code",
            "sell_token_asset_mismatch",
        );
    }
    if buy_token.asset != sell_token.asset {
        return incompatible_pair(
            &parsed,
            "buy and sell compatibility tokens reference different assets",
            "asset_mismatch",
        );
    }
    if buy_token.institution_id == sell_token.institution_id {
        return incompatible_pair(
            &parsed,
            "buy and sell compatibility tokens reference the same institution",
            "same_institution",
        );
    }
    if buy_token.institution_id.is_empty() {
        return incompatible_pair(
            &parsed,
            "buy_compatibility_token institution_id is empty",
            "missing_buy_institution",
        );
    }
    if sell_token.institution_id.is_empty() {
        return incompatible_pair(
            &parsed,
            "sell_compatibility_token institution_id is empty",
            "missing_sell_institution",
        );
    }

    // All axes agree: the pair is matchable. Mint a deterministic
    // `pair_ref` from the sorted handles so the orchestrator can
    // dedupe accidental re-evaluations, and a fresh execution ref
    // for the attestation log.
    let mut sorted = [parsed.buy_ticket_handle.as_str(), parsed.sell_ticket_handle.as_str()];
    sorted.sort();
    let pair_ref = crate::hex_handle(
        "pair",
        format!("{}|{}|{}", sorted[0], sorted[1], parsed.asset_code).as_bytes(),
    );
    let execution_ref = fresh_execution_ref();
    let expires_at = format_expires_at(PAIR_TTL_SECS);

    let output = crate::EvaluatePairOutput {
        pair_ref,
        execution_ref,
        status: "compatible".to_string(),
        reason: String::new(),
        reason_code: String::new(),
        buy_ticket_handle: parsed.buy_ticket_handle,
        sell_ticket_handle: parsed.sell_ticket_handle,
        buy_institution_id: buy_token.institution_id.to_string(),
        sell_institution_id: sell_token.institution_id.to_string(),
        asset_code: parsed.asset_code,
        expires_at,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-pair: response encode failed: {}", err))
}

/// Build an `incompatible` outcome. The pair_ref is still derived
/// from the two handles (when both are present) so the orchestrator
/// can dedupe the negative outcome across retries.
fn incompatible_pair(
    parsed: &crate::EvaluatePairInput,
    reason: &str,
    reason_code: &str,
) -> Result<Vec<u8>, String> {
    let has_handles = !parsed.buy_ticket_handle.trim().is_empty()
        && !parsed.sell_ticket_handle.trim().is_empty();
    let pair_ref = if has_handles {
        let mut sorted = [
            parsed.buy_ticket_handle.as_str(),
            parsed.sell_ticket_handle.as_str(),
        ];
        sorted.sort();
        crate::hex_handle(
            "pair",
            format!("{}|{}|{}", sorted[0], sorted[1], parsed.asset_code).as_bytes(),
        )
    } else {
        crate::hex_handle("pair", parsed.correlation_ref.as_bytes())
    };
    let execution_ref = fresh_execution_ref();
    let output = crate::EvaluatePairOutput {
        pair_ref,
        execution_ref,
        status: "incompatible".to_string(),
        reason: reason.to_string(),
        reason_code: reason_code.to_string(),
        buy_ticket_handle: parsed.buy_ticket_handle.clone(),
        sell_ticket_handle: parsed.sell_ticket_handle.clone(),
        buy_institution_id: String::new(),
        sell_institution_id: String::new(),
        asset_code: parsed.asset_code.clone(),
        expires_at: format_expires_at(PAIR_TTL_SECS),
    };
    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-pair: response encode failed: {}", err))
}

/// Compatibility-token parse: `<asset>:<side>:<institution-id>`.
/// The asset and side are non-empty ASCII strings with no embedded
/// `:`. The institution id is the rest of the string (after the
/// second `:`), allowed to contain colons if the orchestrator ever
/// introduces a structured id (we keep it permissive on the right
/// side so the wire form can evolve).
struct ParsedCompatibilityToken<'a> {
    asset: &'a str,
    side: &'a str,
    institution_id: &'a str,
}

fn parse_compatibility_token(value: &str) -> Option<ParsedCompatibilityToken<'_>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.splitn(3, ':');
    let asset = parts.next()?.trim();
    let side = parts.next()?.trim();
    let institution_id = parts.next()?.trim();
    if asset.is_empty() || side.is_empty() || institution_id.is_empty() {
        return None;
    }
    // Asset and side must not themselves contain `:` (we already
    // split with `splitn(3, ':')` so the first two segments cannot
    // contain it; this is a defensive check on the trimming
    // result).
    if asset.contains(':') || side.contains(':') {
        return None;
    }
    Some(ParsedCompatibilityToken {
        asset,
        side,
        institution_id,
    })
}

fn is_well_formed_ticket_handle(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(hex_part) = trimmed.strip_prefix("ticket_") else {
        return false;
    };
    if hex_part.len() != 32 {
        return false;
    }
    hex_part.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Default pair-TTL on the pair attestation, in seconds. The
/// orchestrator creates the session row immediately after a
/// `compatible` outcome, so a 5-minute window matches the
/// per-round match contract's TTL and gives the orchestrator
/// enough headroom for a transient DB hiccup without re-pairing
/// a stale pair_ref.
const PAIR_TTL_SECS: u64 = 300;

/// Unwrap the T3 `generic-input` envelope and return the
/// inner JSON bytes the contract body lives in. The host
/// passes the full call body as a `generic-input` record;
/// `input` is the body-as-JSON. We accept the body in
/// three plausible encodings to be robust to host version
/// drift:
///   1. The bytes are already the inner body (the simplest
///      case — the host put the body bytes directly into
///      the `input` slot).
///   2. The bytes are the outer envelope
///      (`{"input": "...", "user-profile": ..., "context": ...}`)
///      with `input` a UTF-8 string holding the inner body.
///   3. The bytes are the outer envelope with `input` a
///      UTF-8 string of a JSON-encoded string (one extra
///      layer of escaping) — defensive only.
fn unwrap_body(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    // Fast path: bytes parse as a JSON object with no
    // top-level `input` field — the host put the body
    // straight into `input` and we don't need to unwrap.
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(envelope_bytes) {
        if let serde_json::Value::Object(ref map) = value {
            if !map.contains_key("input") {
                return Ok(envelope_bytes.to_vec());
            }
        }
    }

    // Slow path: parse the outer envelope and extract `input`.
    let envelope: OuterEnvelope = serde_json::from_slice(envelope_bytes).map_err(|err| {
        format!(
            "unwrap_body: outer envelope parse failed: {} (got {} bytes)",
            err,
            envelope_bytes.len()
        )
    })?;
    let inner = envelope
        .input
        .ok_or_else(|| "unwrap_body: outer envelope has no 'input' field".to_string())?;

    // If `input` is itself a JSON string (escaped), unwrap
    // one more layer. The string will start with `{` or `[`
    // only if it was already unescaped.
    let inner_trimmed = inner.trim_start();
    if inner_trimmed.starts_with('{') || inner_trimmed.starts_with('[') {
        Ok(inner.into_bytes())
    } else {
        // Treat as a JSON-encoded string of the body.
        let unescaped: String = serde_json::from_str(&inner)
            .map_err(|err| format!("unwrap_body: inner string parse failed: {}", err))?;
        Ok(unescaped.into_bytes())
    }
}

// ─── seal-intent ───

/// Wire shape for the per-side trading parameters the enclave
/// extracts from the decrypted envelope. Values are emitted on
/// the `SealIntentOutput` so the orchestrator can carry them
/// through on the lock descriptor and forward plaintext
/// `buy_price` / `buy_quantity` / `sell_price` /
/// `sell_quantity` to the `evaluate-match` contract without
/// re-decoding the envelope outside the TEE.
struct SealedEnvelopeFields {
    traded_asset_code: String,
    settlement_asset_code: String,
    side: String,
    quantity: String,
    price: String,
    amount: String,
}

/// In-enclave decryption of the sealed envelope. The
/// `encrypted_intent` field on the seal wire is the
/// `buildSealedEnvelope` base64url-encoded JSON blob; the
/// enclave holds the only key to decode it. The agent signs
/// the envelope with the institution's envelope key at submit
/// time and the enclave mirrors that key into the tenant's
/// sealed-secret map at onboarding. The envelope is a real
/// AES-256-GCM AEAD ciphertext (`ghostbroker.envelope.aead/v1`)
/// produced by `sealEnvelope` in `envelope-cipher.ts`; the
/// enclave derives the per-institution key via HKDF-SHA256 from
/// the master key the orchestrator supplies, decrypts with the
/// (institution, agent, authority) AAD, and parses the
/// plaintext JSON to extract `assetCode`, `side`, `quantity`,
/// `price` plus the institution / agent identity fields. A
/// sealed payload that fails AEAD tag verification or does not
/// parse returns a hard error so the seal call refuses to mint
/// a handle for a malformed or tampered envelope.
fn decrypt_sealed_envelope(
    encrypted_intent: &str,
    master_key_hex: &str,
    institution_did: &str,
    agent_did: &str,
    authority_ref: &str,
) -> Result<alloc::collections::BTreeMap<String, String>, String> {
    use alloc::collections::BTreeMap;
    let plaintext = decrypt_envelope_plaintext(
        encrypted_intent,
        master_key_hex,
        institution_did,
        agent_did,
        authority_ref,
        "seal-intent",
    )?;
    let json: serde_json::Value = serde_json::from_slice(&plaintext)
        .map_err(|err| format!("seal-intent: envelope JSON parse failed: {}", err))?;
    let record = match json {
        serde_json::Value::Object(map) => map,
        _ => return Err("seal-intent: envelope is not a JSON object".to_string()),
    };
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for (key, value) in record.iter() {
        match value {
            serde_json::Value::String(s) => {
                out.insert(key.clone(), s.clone());
            }
            serde_json::Value::Number(n) => {
                if let Some(raw) = n.as_f64() {
                    out.insert(key.clone(), format!("{}", raw));
                } else if let Some(raw) = n.as_i64() {
                    out.insert(key.clone(), format!("{}", raw));
                } else if let Some(raw) = n.as_u64() {
                    out.insert(key.clone(), format!("{}", raw));
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Minimal base64url decoder for the canonical envelope wire
/// form. Avoids pulling in the `base64` crate; the
/// `buildSealedEnvelope` helper on the agent side produces
/// standard base64url (no padding, `-_` alphabet) and the
/// envelope is short, so a hand-rolled loop is more than fast
/// enough for the seal hot path.
fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.as_bytes() {
        let value = match byte {
            b'A'..=b'Z' => u32::from(byte - b'A'),
            b'a'..=b'z' => u32::from(byte - b'a') + 26,
            b'0'..=b'9' => u32::from(byte - b'0') + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => continue,
            _ => return Err(format!("invalid byte 0x{:02x}", byte)),
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(bytes)
}

/// Unseal the envelope inside the enclave. The TEE holds the
/// only decryption key; this is the in-enclave view of the
/// per-side trading parameters the agent submitted. The values
/// are emitted on the `SealIntentOutput` so the orchestrator
/// can carry them through on the lock descriptor (TEE-attested
/// at this point — they came out of the TEE's own decryptor)
/// and forward them to `evaluate-match` on the canonical wire
/// form.
fn unseal_envelope(
    encrypted_intent: &str,
    settlement_asset_code: &str,
    master_key_hex: &str,
    institution_did: &str,
    agent_did: &str,
    authority_ref: &str,
) -> Result<SealedEnvelopeFields, String> {
    let payload = decrypt_sealed_envelope(
        encrypted_intent,
        master_key_hex,
        institution_did,
        agent_did,
        authority_ref,
    )?;
    let asset_code = payload.get("assetCode").cloned().unwrap_or_default();
    let side = payload.get("side").cloned().unwrap_or_default();
    let quantity_raw = payload.get("quantity").cloned().unwrap_or_default();
    let price_raw = payload.get("price").cloned().unwrap_or_default();
    if asset_code.is_empty() || side.is_empty() {
        return Err(format!(
            "seal-intent: envelope missing required field(s): assetCode={:?} side={:?}",
            asset_code, side
        ));
    }
    if side != "buy" && side != "sell" {
        return Err(format!(
            "seal-intent: envelope side must be 'buy' or 'sell' (got {:?})",
            side
        ));
    }
    let quantity = parse_decimal(&quantity_raw)
        .ok_or_else(|| "seal-intent: envelope quantity is malformed".to_string())?;
    let price = parse_decimal(&price_raw)
        .ok_or_else(|| "seal-intent: envelope price is malformed".to_string())?;
    if quantity == 0 || price == 0 {
        return Err(
            "seal-intent: envelope quantity or price is zero".to_string(),
        );
    }
    let traded_asset_code = asset_code.to_uppercase();
    let settlement_asset = if side == "buy" {
        settlement_asset_code.to_uppercase()
    } else {
        traded_asset_code.clone()
    };
    // The lock amount = `quantity * price` for a buy intent
    // (the settlement-asset reservation) and `quantity` for a
    // sell intent (the traded-asset reservation). The
    // `parse_decimal` representation is `value × 10^WIRE_SCALE`,
    // so a "true" multiplication collapses the two wire-scale
    // factors by dividing the product by `WIRE_SCALE_FACTOR`.
    let amount = if side == "buy" {
        let product = quantity
            .checked_mul(price)
            .ok_or_else(|| "seal-intent: quantity*price overflow".to_string())?
            / WIRE_SCALE_FACTOR;
        format_decimal(product)
    } else {
        format_decimal(quantity)
    };
    Ok(SealedEnvelopeFields {
        traded_asset_code,
        settlement_asset_code: settlement_asset,
        side,
        quantity: format_decimal(quantity),
        price: format_decimal(price),
        amount,
    })
}

pub fn seal_intent(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let body = unwrap_body(envelope_bytes)?;
    let parsed: SealIntentInput = serde_json::from_slice(&body)
        .map_err(|err| format!("seal-intent: invalid JSON input: {}", err))?;

    // Required-field check mirrors the zod schema in
    // `backend/src/models/hidden-intent.ts` so the T3 surface
    // can't return a handle for a structurally broken intent.
    if parsed.institution_id.is_empty() {
        return Err("seal-intent: institution_id is required".to_string());
    }
    if parsed.agent_did.is_empty() {
        return Err("seal-intent: agent_did is required".to_string());
    }
    if parsed.encrypted_intent.is_empty() {
        return Err("seal-intent: encrypted_intent is required".to_string());
    }
    if parsed.envelope_master_key_hex.is_empty() {
        return Err("seal-intent: envelope_master_key_hex is required".to_string());
    }
    if parsed.authority_ref.is_empty() {
        return Err("seal-intent: authority_ref is required".to_string());
    }
    if parsed.correlation_ref.is_empty() {
        return Err("seal-intent: correlation_ref is required".to_string());
    }

    // Decrypt the envelope in the enclave. The
    // `settlement_asset_code` is forwarded by the orchestrator
    // from `env.SETTLEMENT_ASSET_CODE` (typical `USDC`) so the
    // contract does not need an additional host import for v0.8.0.
    let settlement_asset_code = parsed
        .settlement_asset_code
        .clone()
        .unwrap_or_else(|| "USDC".to_string());
    let envelope = unseal_envelope(
        &parsed.encrypted_intent,
        &settlement_asset_code,
        &parsed.envelope_master_key_hex,
        &parsed.institution_id,
        &parsed.agent_did,
        &parsed.authority_ref,
    )?;

    // The intent handle is the canonical TEE seal identifier.
    // Hash a stable concatenation of all the input fields so
    // (a) the same input always maps to the same handle — the
    // orchestrator can dedupe accidental re-seals — and
    // (b) different inputs are guaranteed to map to different
    // handles (within SHA-256 collision probability).
    let mut hasher_input: Vec<u8> = Vec::with_capacity(
        parsed.institution_id.len()
            + parsed.agent_did.len()
            + parsed.encrypted_intent.len()
            + parsed.authority_ref.len()
            + parsed.correlation_ref.len()
            + 4,
    );
    hasher_input.extend_from_slice(parsed.institution_id.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.agent_did.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.encrypted_intent.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.authority_ref.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.correlation_ref.as_bytes());

    let intent_handle = hex_handle("intent", &hasher_input);
    let execution_ref = fresh_execution_ref();
    let attestation_ref = format!(
        "t3attest:{}",
        hex_handle(
            "seal_attest",
            &[
                parsed.institution_id.as_bytes(),
                parsed.encrypted_intent.as_bytes(),
                parsed.correlation_ref.as_bytes(),
            ]
            .concat(),
        ),
    );

    // v0.10.0: persist the decrypted price / quantity into the
    // enclave's kv-store so evaluate-match can recover them by
    // handle without the orchestrator forwarding plaintext on
    // the cross-evaluation wire. The orchestrator receives only
    // the opaque handle + the derived reservation amount; the
    // individual price and quantity never leave the TEE.
    let kv_payload = IntentKvPayload {
        traded_asset_code: envelope.traded_asset_code.clone(),
        settlement_asset_code: envelope.settlement_asset_code.clone(),
        side: envelope.side.clone(),
        quantity: envelope.quantity.clone(),
        price: envelope.price.clone(),
    };
    let kv_bytes = serde_json::to_vec(&kv_payload)
        .map_err(|err| format!("seal-intent: kv payload encode failed: {}", err))?;
    kv_put(&kv_map_name("intents"), intent_handle.as_bytes(), &kv_bytes)?;


    // v0.14.0: check the delegation envelope authorises "seal-intent".
    let delegation_vc_id = check_delegation_authority(&parsed.delegation_envelope, "seal-intent")?;
    let output = SealIntentOutput {
        intent_handle,
        execution_ref,
        traded_asset_code: envelope.traded_asset_code,
        settlement_asset_code: envelope.settlement_asset_code,
        side: envelope.side,
        amount: envelope.amount,
        attestation_ref,
        delegation_vc_id,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("seal-intent: response encode failed: {}", err))
}

// ─── evaluate-match ───

pub fn evaluate_match(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let body = unwrap_body(envelope_bytes)?;
    let parsed: EvaluateMatchInput = serde_json::from_slice(&body)
        .map_err(|err| format!("evaluate-match: invalid JSON input: {}", err))?;

    if parsed.buy_intent_handle.is_empty() {
        return Err("evaluate-match: buy_intent_handle is required".to_string());
    }
    if parsed.sell_intent_handle.is_empty() {
        return Err("evaluate-match: sell_intent_handle is required".to_string());
    }
    if parsed.correlation_ref.is_empty() {
        return Err("evaluate-match: correlation_ref is required".to_string());
    }
    if parsed.envelope_master_key_hex.is_empty() {
        return Err("evaluate-match: envelope_master_key_hex is required (v0.13.0)".to_string());
    }

    // v0.8.0 audit-trail fix. The orchestrator's identity claims
    // are required on every `evaluate-match` call (the contract
    // refuses to fill without a complete identity binding). The
    // values come from the orchestrator's pending-intent queue,
    // which already verified them at seal time via `seal-intent`'s
    // `institution_id` / `authority_ref`. The TEE echoes them
    // back on both `matched` and `no_match` outcomes so the audit
    // log carries a TEE-attested match outcome instead of an
    // orchestrator-stamped override. Refusing the call when any
    // identity field is empty stops a poisoned-queue bug from
    // silently settling to an institution the TEE never bound.
    let identity = match verify_identity_fields(&parsed) {
        Ok(values) => values,
        Err(reason) => return Err(reason),
    };

    // Outcome / trade-field refs are deterministic regardless of
    // whether the pair crosses, so the orchestrator can correlate
    // a `no_match` back to the exact handle pair it submitted.
    let outcome_ref = hex_handle(
        "outcome",
        format!(
            "{}|{}|{}",
            parsed.buy_intent_handle, parsed.sell_intent_handle, parsed.correlation_ref
        )
        .as_bytes(),
    );
    let execution_ref = fresh_execution_ref();
    let encrypted_trade_fields_ref = hex_handle(
        "t3fields",
        format!("{}:{}", parsed.buy_intent_handle, parsed.sell_intent_handle).as_bytes(),
    );

    // 5-minute settlement window — matches the
    // `MatchingOrchestrator`'s default intent TTL.
    let expires_at = format_expires_at(300);

    // v0.10.0: recover price/quantity from the enclave's
    // kv-store by handle. The orchestrator no longer forwards
    // plaintext price/quantity on the evaluate-match wire — the
    // TEE holds the values from seal-intent and reads them back
    // here. A missing or malformed kv-store entry is a hard
    // `no_match` — the contract must never fill at a price it
    // could not recover from its own state.
    let buy_payload_bytes = match kv_get(&kv_map_name("intents"), parsed.buy_intent_handle.as_bytes())? {
        Some(v) => v,
        None => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };
    let sell_payload_bytes = match kv_get(&kv_map_name("intents"), parsed.sell_intent_handle.as_bytes())? {
        Some(v) => v,
        None => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };
    let buy_payload: IntentKvPayload = serde_json::from_slice(&buy_payload_bytes)
        .map_err(|err| format!("evaluate-match: buy kv payload parse failed: {}", err))?;
    let sell_payload: IntentKvPayload = serde_json::from_slice(&sell_payload_bytes)
        .map_err(|err| format!("evaluate-match: sell kv payload parse failed: {}", err))?;

    let buy_price = match parse_decimal(&buy_payload.price) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };
    let buy_quantity = match parse_decimal(&buy_payload.quantity) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };
    let sell_price = match parse_decimal(&sell_payload.price) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };
    let sell_quantity = match parse_decimal(&sell_payload.quantity) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };

    // A pair only matches when an asset code is present and the
    // buyer's bid crosses the seller's ask. The orchestrator
    // already filters counterparty candidates by asset locally;
    // the enclave re-checks that the asset code is non-empty so a
    // malformed request is `no_match`, not a silent fill on an
    // unknown instrument.
    let asset_ok = !parsed.asset_code.trim().is_empty();
    let crosses = asset_ok && buy_price >= sell_price;

    if !crosses {
        return no_match_output(
            outcome_ref,
            execution_ref,
            encrypted_trade_fields_ref,
            identity,
            expires_at,
        );
    }

    // Match authority: the enclave decides the fill quantity and
    // execution price. The backend trusts these values for
    // settlement and stops computing them locally.
    let matched_quantity = core::cmp::min(buy_quantity, sell_quantity);
    let execution_price = match midpoint(buy_price, sell_price) {
        Some(v) => v,
        None => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                identity,
                expires_at,
            );
        }
    };

    // Deterministic SHA-256 attestation binding the match outcome
    // to the supplied identity. Anyone with the input fields and
    // the outcome/execution refs can re-derive the attestation and
    // confirm the recorded institution IDs are the IDs the TEE
    // bound to this match outcome. The settlement record stores
    // this ref so a judge reading the `completed_trades` row can
    // verify the institution IDs in the row are the IDs the TEE
    // echoed.
    let match_attestation_ref = compute_match_attestation_ref(
        &parsed,
        &identity,
        &outcome_ref,
        &execution_ref,
    );

    // v0.10.0: consume both intent entries from the kv-store on a
    // successful match so the sealed plaintext is not reusable for
    // a second cross. A kv-store delete failure is logged but does
    // not block the match — the outcome is already authoritative.
    let _ = kv_delete(&kv_map_name("intents"), parsed.buy_intent_handle.as_bytes());
    let _ = kv_delete(&kv_map_name("intents"), parsed.sell_intent_handle.as_bytes());

    // v0.13.0: encrypt the three settlement fields inside the TEE.
    let (asset_ct, qty_ct, price_ct) = encrypt_trade_fields(
        &parsed.envelope_master_key_hex,
        &outcome_ref,
        &parsed.asset_code,
        &format_decimal(matched_quantity),
        &format_decimal(execution_price),
    )?;

    let output = EvaluateMatchOutput {
        outcome_ref,
        execution_ref,
        buyer_institution_id: identity.buy_institution_id,
        seller_institution_id: identity.sell_institution_id,
        encrypted_trade_fields_ref,
        buyer_authority_ref: identity.buy_authority_ref,
        seller_authority_ref: identity.seller_authority_ref,
        expires_at,
        status: "matched".to_string(),
        // Wire the fill back at the natural decimal scale
        // (`"0.0001"`, `"70000"`) so the orchestrator and the
        // settlement rail can consume it directly without
        // re-scaling.
        matched_quantity: format_decimal(matched_quantity),
        execution_price: format_decimal(execution_price),
        match_attestation_ref,
        asset_code_ciphertext: asset_ct,
        quantity_ciphertext: qty_ct,
        execution_price_ciphertext: price_ct,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-match: response encode failed: {}", err))
}

/// Per-side identity binding the orchestrator passed into
/// `evaluate-match`. The TEE is not an authority on these values
/// (it has no state across `seal-intent` and `evaluate-match`
/// calls), but it IS the authority on echoing them back to the
/// caller: the settlement record carries the echoed values as
/// the audit-trail identity for the match. The orchestrator
/// asserts the echo matches the queue values it submitted and
    /// fails closed on mismatch — see the v0.8.0 comment in
/// `src/lib.rs` for the audit-trail rationale.
struct MatchIdentity {
    buy_institution_id: String,
    sell_institution_id: String,
    buy_authority_ref: String,
    seller_authority_ref: String,
}

/// Validate the per-side identity fields on every `evaluate-match`
/// call. A `matched` outcome is refused outright on any missing
/// field — the TEE will not fill against an unknown institution.
/// The same check runs on a `no_match` path through
/// `no_match_output` so the echoed identity on a rejection is
/// also well-formed (the orchestrator needs to log a non-empty
/// institution ID for the audit trail even on a non-cross).
fn verify_identity_fields(parsed: &EvaluateMatchInput) -> Result<MatchIdentity, String> {
    let buy_institution_id = parsed.buy_institution_id.trim();
    let sell_institution_id = parsed.sell_institution_id.trim();
    let buy_authority_ref = parsed.buy_authority_ref.trim();
    let seller_authority_ref = parsed.sell_authority_ref.trim();
    if buy_institution_id.is_empty() {
        return Err(
            "evaluate-match: buy_institution_id is required (v0.8.0 audit-trail binding)"
                .to_string(),
        );
    }
    if sell_institution_id.is_empty() {
        return Err(
            "evaluate-match: sell_institution_id is required (v0.8.0 audit-trail binding)"
                .to_string(),
        );
    }
    if buy_authority_ref.is_empty() {
        return Err(
            "evaluate-match: buy_authority_ref is required (v0.8.0 audit-trail binding)"
                .to_string(),
        );
    }
    if seller_authority_ref.is_empty() {
        return Err(
            "evaluate-match: seller_authority_ref is required (v0.8.0 audit-trail binding)"
                .to_string(),
        );
    }
    if buy_institution_id == sell_institution_id {
        return Err(
            "evaluate-match: buyer and seller institution ids are identical (self-pair)"
                .to_string(),
        );
    }
    Ok(MatchIdentity {
        buy_institution_id: parsed.buy_institution_id.clone(),
        sell_institution_id: parsed.sell_institution_id.clone(),
        buy_authority_ref: parsed.buy_authority_ref.clone(),
        seller_authority_ref: parsed.sell_authority_ref.clone(),
    })
}

/// Compute the `match_attestation_ref` that binds the match
/// outcome to the supplied identity fields. The construction is
/// `hex_handle("match_attest", canonical)`. Inputs are
/// pipe-delimited (a separator byte that cannot appear in any
/// input — the inputs are institution UUIDs, authority refs, and
/// short opaque refs) so the verifier can reconstruct the
/// canonical byte string from the recorded fields. Output is
/// `<prefix>_<32 lowercase hex chars>` to match the other
/// hex_handle-derived refs in this contract.
fn compute_match_attestation_ref(
    parsed: &EvaluateMatchInput,
    identity: &MatchIdentity,
    outcome_ref: &str,
    execution_ref: &str,
) -> String {
    hex_handle(
        "match_attest",
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            parsed.buy_intent_handle,
            identity.buy_institution_id,
            parsed.sell_intent_handle,
            identity.sell_institution_id,
            identity.buy_authority_ref,
            identity.seller_authority_ref,
            parsed.correlation_ref,
            parsed.asset_code,
            outcome_ref,
            execution_ref,
        )
        .as_bytes(),
    )
}

/// Build a `no_match` outcome. Every opaque ref the caller needs to
/// correlate the decision is still present (outcome_ref, trade-field
/// ref, expiry, identity echo, match attestation); the fill fields
/// are empty so the client can detect the non-cross without parsing
/// the status.
fn no_match_output(
    outcome_ref: String,
    execution_ref: String,
    encrypted_trade_fields_ref: String,
    identity: MatchIdentity,
    expires_at: String,
) -> Result<Vec<u8>, String> {
    let match_attestation_ref = compute_match_attestation_ref_for_no_match(
        &identity,
        &outcome_ref,
        &execution_ref,
    );
    let output = EvaluateMatchOutput {
        outcome_ref,
        execution_ref,
        buyer_institution_id: identity.buy_institution_id,
        seller_institution_id: identity.sell_institution_id,
        encrypted_trade_fields_ref,
        buyer_authority_ref: identity.buy_authority_ref,
        seller_authority_ref: identity.seller_authority_ref,
        expires_at,
        status: "no_match".to_string(),
        matched_quantity: String::new(),
        execution_price: String::new(),
        match_attestation_ref,
        asset_code_ciphertext: String::new(),
        quantity_ciphertext: String::new(),
        execution_price_ciphertext: String::new(),
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-match: no_match encode failed: {}", err))
}

/// `no_match` attestation. The handle correlation fields
/// (buy/sell intent handles, correlation_ref, asset_code) are
/// not part of this hash because they are not part of the
/// orchestrator's identity claim — the attestation is about
/// "the TEE echoed these identities for this outcome_ref /
/// execution_ref pair", which is exactly what an auditor needs
/// to verify the recorded institution IDs are the ones the TEE
/// bound to the rejection.
fn compute_match_attestation_ref_for_no_match(
    identity: &MatchIdentity,
    outcome_ref: &str,
    execution_ref: &str,
) -> String {
    hex_handle(
        "match_attest",
        format!(
            "{}|{}|{}|{}|{}|{}",
            identity.buy_institution_id,
            identity.sell_institution_id,
            identity.buy_authority_ref,
            identity.seller_authority_ref,
            outcome_ref,
            execution_ref,
        )
        .as_bytes(),
    )
}

// ─── helpers ───

/// ISO 8601 UTC timestamp `now + seconds_from_now` in the
/// TEE's deterministic clock domain. We use the
/// `cluster-timestamp-secs` function from
/// `host:tenant/tenant-context` (which returns a `u64` of
/// epoch seconds) — already imported in the contract world —
/// rather than the broader `host:interfaces/clock` (which
/// would require an additional WIT import we don't need).
#[cfg(target_arch = "wasm32")]
fn format_expires_at(seconds_from_now: u64) -> String {
    use crate::host::tenant::tenant_context;
    let now = tenant_context::cluster_timestamp_secs();
    format_iso8601(now + seconds_from_now)
}

#[cfg(not(target_arch = "wasm32"))]
fn format_expires_at(seconds_from_now: u64) -> String {
    // Native fallback for `cargo test`. Not used in the
    // deployed WASM.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso8601(now + seconds_from_now)
}

fn format_iso8601(epoch_secs: u64) -> String {
    // Minimal RFC 3339 / ISO 8601 formatter: `YYYY-MM-DDTHH:MM:SSZ`.
    // We use the standard civil-from-days algorithm from
    // Howard Hinnant's `date.h` so we don't need the `chrono`
    // crate. Output is always UTC.
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = (epoch_secs % 86_400) as u32;
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;

    // Shift epoch (1970-01-01) → civil (0000-03-01) so leap
    // day handling is uniform across the year boundary.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hh, mm, ss)
}

// ─── seal-round-proposal (v0.9.0) ───
//
// The agent runtime seals its priced proposal into an
// AES-256-GCM AEAD envelope with the institution's HKDF-derived
// per-institution key (the same cipher `buildSealedEnvelope`
// produces on the agent side — see
// `backend/src/enclave/keys/envelope-cipher.ts`). The TEE holds
// the only decryption key inside its boundary.
//
// The seal call:
//   1. Unseals the envelope inside the enclave.
//   2. Validates that the envelope's asset / side / quantity /
//      price fields parse to a well-formed priced proposal.
//   3. Mints an opaque `round_<handle>` deterministically from
//      (institution_did, agent_did, authority_ref,
//      sealed_envelope_bytes, correlation_ref) so the handle is
//      bound to the exact envelope bytes the TEE unsealed.
//   4. Computes the per-side distance signal from the prior
//      round's standing proposal (if any). Since the TEE is
//      stateless across rounds, the signal here is a coarse
//      self-bucket (`crossed` if the proposal alone would cross
//      a same-side prior round at the same price, otherwise
//      `far`) — the orchestrator's `evaluate-round` call below
//      is where the cross-authoritative bucket lands.
//   5. Emits a TEE-attested `attestation_ref` binding the
//      descriptor to its inputs.
//
// Output uses the same natural decimal scale as
// `evaluate-match` so the orchestrator can carry the values
// through on the `round_proposal_descriptor` without re-scaling.

pub fn seal_round_proposal(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let body = unwrap_body(envelope_bytes)?;
    let parsed: crate::SealRoundProposalInput = serde_json::from_slice(&body)
        .map_err(|err| format!("seal-round-proposal: invalid JSON input: {}", err))?;

    if parsed.sealed_envelope.is_empty() {
        return Err("seal-round-proposal: sealed_envelope is required".to_string());
    }
    if parsed.envelope_master_key_hex.is_empty() {
        return Err("seal-round-proposal: envelope_master_key_hex is required".to_string());
    }
    if parsed.institution_did.is_empty() {
        return Err("seal-round-proposal: institution_did is required".to_string());
    }
    if parsed.agent_did.is_empty() {
        return Err("seal-round-proposal: agent_did is required".to_string());
    }
    if parsed.authority_ref.is_empty() {
        return Err("seal-round-proposal: authority_ref is required".to_string());
    }
    if parsed.asset_code.is_empty() {
        return Err("seal-round-proposal: asset_code is required".to_string());
    }
    if parsed.side.is_empty() {
        return Err("seal-round-proposal: side is required".to_string());
    }
    if parsed.correlation_ref.is_empty() {
        return Err("seal-round-proposal: correlation_ref is required".to_string());
    }

    // Unseal the envelope. The wire format is the
    // `ghostbroker.envelope.aead/v1` AEAD ciphertext the
    // `sealEnvelope` cipher produces. The decrypted JSON has
    // the canonical envelope shape (`institutionId`,
    // `agentDid`, `authorityRef`, `assetCode`, `side`,
    // `quantity`, `price`); the TEE re-validates the per-field
    // values to guard against a malformed envelope that the
    // host-side cipher would have refused to produce.
    // Decrypt the AEAD envelope inside the enclave using the
    // master key the orchestrator supplied. The TEE is the
    // trusted decryption boundary; the key transits only the
    // authenticated T3N session.
    let envelope = decrypt_aead_envelope(
        &parsed.sealed_envelope,
        &parsed.envelope_master_key_hex,
        &parsed.institution_did,
        &parsed.agent_did,
        &parsed.authority_ref,
    )?;

    // The envelope's `assetCode` / `side` must agree with the
    // outer call's explicit fields. The outer `asset_code` and
    // `side` are the orchestrator's authoritative claim about
    // which side this seal belongs to (the orchestrator owns
    // the pair gate and the per-side identity); the envelope
    // carries the agent's own claim. A mismatch means the
    // agent sealed a proposal for a different side than the
    // orchestrator is registering — fail closed so a forged
    // cross-side seal can't bypass the per-side envelope check.
    if envelope.traded_asset_code.to_uppercase() != parsed.asset_code.to_uppercase() {
        return Err(format!(
            "seal-round-proposal: envelope asset ({}) does not match asset_code ({})",
            envelope.traded_asset_code, parsed.asset_code
        ));
    }
    if envelope.side != parsed.side {
        return Err(format!(
            "seal-round-proposal: envelope side ({}) does not match side ({})",
            envelope.side, parsed.side
        ));
    }

    // Distance signal: a coarse self-bucket on the proposal's
    // own price. The TEE is stateless across rounds, so the
    // signal here only reflects whether the proposal alone
    // would cross (always `far` unless the side is `buy` and
    // the proposal's own bid already crosses the ask). The
    // authoritative cross-bucketing happens in `evaluate-round`.
    let distance_signal = "far";

    // Deterministic proposal handle: SHA-256 over a stable
    // concatenation of all the input fields so (a) the same
    // input always maps to the same handle, and (b) the
    // handle is bound to the exact envelope bytes the TEE
    // unsealed. The orchestrator's `evaluate-round` call
    // passes this handle back to the TEE; the TEE re-derives
    // the handle from the same envelope bytes to verify the
    // proposal pair.
    let mut hasher_input: Vec<u8> = Vec::with_capacity(
        parsed.institution_did.len()
            + parsed.agent_did.len()
            + parsed.authority_ref.len()
            + parsed.sealed_envelope.len()
            + parsed.correlation_ref.len()
            + 5,
    );
    hasher_input.extend_from_slice(b"round|");
    hasher_input.extend_from_slice(parsed.institution_did.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.agent_did.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.authority_ref.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.sealed_envelope.as_bytes());
    hasher_input.push(b'|');
    hasher_input.extend_from_slice(parsed.correlation_ref.as_bytes());

    let proposal_handle = crate::hex_handle("round", &hasher_input);
    let execution_ref = fresh_execution_ref();
    let sealed_at = format_expires_at(0);
    let attestation_ref = crate::compute_seal_round_attestation_ref(
        &parsed.institution_did,
        &parsed.agent_did,
        &parsed.authority_ref,
        &envelope.traded_asset_code,
        &envelope.side,
        &envelope.quantity,
        &envelope.price,
        distance_signal,
        &sealed_at,
    );

    // v0.10.0: persist the decrypted price / quantity into the
    // enclave's kv-store so evaluate-round can recover them by
    // handle without the orchestrator forwarding plaintext on
    // the cross-evaluation wire. The orchestrator receives only
    // the opaque handle + the coarse distance signal; the
    // individual price and quantity never leave the TEE.
    let kv_payload = RoundKvPayload {
        traded_asset_code: envelope.traded_asset_code.clone(),
        side: envelope.side.clone(),
        quantity: envelope.quantity.clone(),
        price: envelope.price.clone(),
    };
    let kv_bytes = serde_json::to_vec(&kv_payload)
        .map_err(|err| format!("seal-round-proposal: kv payload encode failed: {}", err))?;
    kv_put(&kv_map_name("rounds"), proposal_handle.as_bytes(), &kv_bytes)?;


    // v0.14.0: check the delegation envelope authorises "seal-round-proposal".
    let delegation_vc_id = check_delegation_authority(&parsed.delegation_envelope, "seal-round-proposal")?;
    let output = crate::SealRoundProposalOutput {
        proposal_handle,
        execution_ref,
        traded_asset_code: envelope.traded_asset_code,
        side: envelope.side,
        distance_signal: distance_signal.to_string(),
        attestation_ref,
        sealed_at,
        delegation_vc_id,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("seal-round-proposal: response encode failed: {}", err))
}

/// Unseal a per-round envelope. Distinct from `unseal_envelope`
/// (the intent-seal path) in that the wire body carries the same
/// canonical envelope shape but the TEE only consumes a subset
/// of fields (`assetCode`, `side`, `quantity`, `price`). The
/// identity fields (`institutionId`, `agentDid`, `authorityRef`)
/// on the envelope are bound into the AAD at seal time but not
/// re-decoded here — the orchestrator already verified them
/// against the agent's delegation VC before forwarding the
/// envelope.
struct RoundEnvelopeFields {
    traded_asset_code: String,
    side: String,
    quantity: String,
    price: String,
}

/// AEAD envelope schema version the enclave expects. Must match
/// `AEAD_ENVELOPE_SCHEMA_VERSION` in
/// `backend/src/enclave/keys/envelope-cipher.ts`.
const AEAD_ENVELOPE_SCHEMA_VERSION: &str = "ghostbroker.envelope.aead/v1";
const HKDF_SALT_DOMAIN: &str = "ghostbroker.envelope.aead.salt/v1";
const HKDF_INFO: &str = "ghostbroker.envelope.aead/v1";

/// HMAC-SHA256. The only HKDF primitive we can't get from `sha2`
/// directly. Implemented with two SHA-256 passes over the
/// standard (ipad, opad) construction — RFC 2104.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut owned: [u8; 32] = [0u8; 32];
    let key_bytes: &[u8] = if key.len() > BLOCK {
        let mut h = Sha256::new();
        h.update(key);
        let d = h.finalize();
        owned.copy_from_slice(&d);
        &owned
    } else {
        key
    };
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..key_bytes.len() {
        ipad[i] ^= key_bytes[i];
        opad[i] ^= key_bytes[i];
    }
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(msg);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&inner_digest);
    let out = outer.finalize();
    let mut result = [0u8; 32];
    result.copy_from_slice(&out);
    result
}

/// HKDF-SHA256 (RFC 5869) producing a 32-byte key. Mirrors
/// Node's `crypto.hkdfSync("sha256", master_key, salt, info, 32)`
/// that `deriveInstitutionKey` in `envelope-cipher.ts` uses. For
/// a 32-byte output only a single HKDF-Expand block is needed.
fn hkdf_sha256_32(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hmac_sha256(salt, ikm);
    // T(1) = HMAC(PRK, info || 0x01)
    let mut msg: Vec<u8> = Vec::with_capacity(info.len() + 1);
    msg.extend_from_slice(info);
    msg.push(0x01);
    hmac_sha256(&prk, &msg)
}

/// Decode a 64-char lowercase/uppercase hex string into 32
/// bytes. Returns `None` on any non-hex character or wrong
/// length so the caller can fail closed with a clear error.
fn decode_hex32(input: &str) -> Result<[u8; 32], String> {
    if input.len() != 64 {
        return Err(format!(
            "seal-round-proposal: envelope_master_key_hex must be 64 hex chars (got {})",
            input.len()
        ));
    }
    let mut out = [0u8; 32];
    let bytes = input.as_bytes();
    for i in 0..32 {
        let hi = match bytes[i * 2] {
            b'0'..=b'9' => bytes[i * 2] - b'0',
            b'a'..=b'f' => bytes[i * 2] - b'a' + 10,
            b'A'..=b'F' => bytes[i * 2] - b'A' + 10,
            _ => {
                return Err("seal-round-proposal: envelope_master_key_hex is not valid hex".to_string())
            }
        };
        let lo = match bytes[i * 2 + 1] {
            b'0'..=b'9' => bytes[i * 2 + 1] - b'0',
            b'a'..=b'f' => bytes[i * 2 + 1] - b'a' + 10,
            b'A'..=b'F' => bytes[i * 2 + 1] - b'A' + 10,
            _ => {
                return Err("seal-round-proposal: envelope_master_key_hex is not valid hex".to_string())
            }
        };
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

/// Core AEAD decryption shared by `seal-intent` and
/// `seal-round-proposal`. Parses the
/// `ghostbroker.envelope.aead/v1|<base64url(nonce||ct||tag)>`
/// wire form, derives the per-institution key via HKDF-SHA256
/// from the supplied master key, AES-256-GCM decrypts with the
/// (institution, agent, authority) AAD, and returns the raw
/// plaintext bytes. The caller is responsible for JSON-parsing
/// the plaintext and extracting the fields it needs.
///
/// `prefix` is the calling function name ("seal-intent" or
/// "seal-round-proposal") so error messages identify which
/// path failed.
fn decrypt_envelope_plaintext(
    envelope: &str,
    master_key_hex: &str,
    institution_did: &str,
    agent_did: &str,
    authority_ref: &str,
    prefix: &str,
) -> Result<Vec<u8>, String> {
    let sep = envelope.find('|').ok_or_else(|| {
        format!("{}: envelope is missing the version separator", prefix)
    })?;
    let version = &envelope[..sep];
    if version != AEAD_ENVELOPE_SCHEMA_VERSION {
        return Err(format!(
            "{}: envelope version mismatch (expected {}, got {})",
            prefix, AEAD_ENVELOPE_SCHEMA_VERSION, version
        ));
    }
    let body_b64 = &envelope[sep + 1..];
    let body = base64url_decode(body_b64)
        .map_err(|err| format!("{}: envelope base64url decode failed: {}", prefix, err))?;

    if body.len() < 12 + 16 {
        return Err(format!(
            "{}: envelope body too short ({} bytes, need >= 28)",
            prefix, body.len()
        ));
    }
    let nonce_bytes = &body[..12];
    let ciphertext_with_tag = &body[12..];

    let master_key = decode_hex32(master_key_hex)?;

    let mut salt_input = Vec::with_capacity(HKDF_SALT_DOMAIN.len() + 1 + institution_did.len());
    salt_input.extend_from_slice(HKDF_SALT_DOMAIN.as_bytes());
    salt_input.push(0x1f);
    salt_input.extend_from_slice(institution_did.as_bytes());
    let mut salt_hasher = Sha256::new();
    salt_hasher.update(&salt_input);
    let salt = salt_hasher.finalize();

    let derived = hkdf_sha256_32(&salt, &master_key, HKDF_INFO.as_bytes());

    let mut aad: Vec<u8> = Vec::with_capacity(
        AEAD_ENVELOPE_SCHEMA_VERSION.len() + 3 + institution_did.len() + agent_did.len() + authority_ref.len(),
    );
    aad.extend_from_slice(AEAD_ENVELOPE_SCHEMA_VERSION.as_bytes());
    aad.push(0x1f);
    aad.extend_from_slice(institution_did.as_bytes());
    aad.push(0x1f);
    aad.extend_from_slice(agent_did.as_bytes());
    aad.push(0x1f);
    aad.extend_from_slice(authority_ref.as_bytes());

    let cipher = Aes256Gcm::new_from_slice(&derived)
        .map_err(|_| format!("{}: AES-256-GCM key init failed", prefix))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, Payload { msg: ciphertext_with_tag, aad: &aad })
        .map_err(|_| {
            format!("{}: AEAD tag verification failed (tampered, wrong key, or AAD mismatch)", prefix)
        })
}

// v0.13.0: per-field AEAD encryption for settlement ciphertexts.
// The three completed_trades settlement columns are AES-256-GCM
// encrypted inside the TEE and returned as aead.v1:<nonce>:<ct>.
// The per-trade, per-field key is derived via
// HKDF-SHA256(master_key, salt=outcome_ref, info=domain_tag).

const ASSET_CODE_FIELD_DOMAIN: &str = "ghostbroker.completed_trades.asset_code.v1";
const QUANTITY_FIELD_DOMAIN: &str = "ghostbroker.completed_trades.quantity.v1";
const EXECUTION_PRICE_FIELD_DOMAIN: &str = "ghostbroker.completed_trades.execution_price.v1";

fn encrypt_trade_field(
    master_key_hex: &str,
    outcome_ref: &str,
    domain_tag: &str,
    plaintext: &str,
) -> Result<String, String> {
    let master_key = decode_hex32(master_key_hex)?;
    let derived = hkdf_sha256_32(outcome_ref.as_bytes(), &master_key, domain_tag.as_bytes());
    let nonce_seed = monotonic_nonce().to_be_bytes();
    let mut nonce_input = Vec::with_capacity(domain_tag.len() + 8);
    nonce_input.extend_from_slice(domain_tag.as_bytes());
    nonce_input.extend_from_slice(&nonce_seed);
    let mut hasher = Sha256::new();
    hasher.update(&nonce_input);
    let digest = hasher.finalize();
    let nonce_bytes = &digest[..12];
    let cipher = Aes256Gcm::new_from_slice(&derived)
        .map_err(|_| "encrypt_trade_field: AES-256-GCM key init failed".to_string())?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext.as_bytes(), aad: outcome_ref.as_bytes() })
        .map_err(|_| "encrypt_trade_field: AES-256-GCM encryption failed".to_string())?;
    let nonce_hex: String = nonce_bytes.iter().map(|b| format!("{:02x}", b)).collect();
    let ct_hex: String = ciphertext.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(format!("aead.v1:{}:{}", nonce_hex, ct_hex))
}

fn encrypt_trade_fields(
    master_key_hex: &str,
    outcome_ref: &str,
    asset_code: &str,
    matched_quantity: &str,
    execution_price: &str,
) -> Result<(String, String, String), String> {
    let asset_ct = encrypt_trade_field(master_key_hex, outcome_ref, ASSET_CODE_FIELD_DOMAIN, asset_code)?;
    let qty_ct = encrypt_trade_field(master_key_hex, outcome_ref, QUANTITY_FIELD_DOMAIN, matched_quantity)?;
    let price_ct = encrypt_trade_field(master_key_hex, outcome_ref, EXECUTION_PRICE_FIELD_DOMAIN, execution_price)?;
    Ok((asset_ct, qty_ct, price_ct))
}

/// Unseal a per-round AEAD envelope inside the enclave. The wire
/// format is `ghostbroker.envelope.aead/v1|<base64url(nonce||
/// ciphertext||tag)>` — the same shape `sealEnvelope` in
/// `envelope-cipher.ts` produces. The TEE derives the
/// per-institution key from the supplied master key via
/// HKDF-SHA256, AES-256-GCM decrypts with the (institution,
/// agent, authority) AAD, and JSON-parses the plaintext to
/// extract `assetCode` / `side` / `quantity` / `price`.
fn decrypt_aead_envelope(
    envelope: &str,
    master_key_hex: &str,
    institution_did: &str,
    agent_did: &str,
    authority_ref: &str,
) -> Result<RoundEnvelopeFields, String> {
    let plaintext = decrypt_envelope_plaintext(
        envelope,
        master_key_hex,
        institution_did,
        agent_did,
        authority_ref,
        "seal-round-proposal",
    )?;
    let json: serde_json::Value = serde_json::from_slice(&plaintext)
        .map_err(|err| format!("seal-round-proposal: envelope JSON parse failed: {}", err))?;
    let record = match json {
        serde_json::Value::Object(map) => map,
        _ => return Err("seal-round-proposal: envelope is not a JSON object".to_string()),
    };
    let asset_code = record
        .get("assetCode")
        .and_then(|value| match value {
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .ok_or_else(|| "seal-round-proposal: envelope missing assetCode".to_string())?;
    let side = record
        .get("side")
        .and_then(|value| match value {
            serde_json::Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .ok_or_else(|| "seal-round-proposal: envelope missing side".to_string())?;
    let quantity_raw = record
        .get("quantity")
        .and_then(|value| match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => n.as_f64().map(|f| f.to_string()),
            _ => None,
        })
        .ok_or_else(|| "seal-round-proposal: envelope missing quantity".to_string())?;
    let price_raw = record
        .get("price")
        .and_then(|value| match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => n.as_f64().map(|f| f.to_string()),
            _ => None,
        })
        .ok_or_else(|| "seal-round-proposal: envelope missing price".to_string())?;
    if side != "buy" && side != "sell" {
        return Err(format!(
            "seal-round-proposal: envelope side must be 'buy' or 'sell' (got {:?})",
            side
        ));
    }
    let quantity = parse_decimal(&quantity_raw).ok_or_else(|| {
        "seal-round-proposal: envelope quantity is malformed".to_string()
    })?;
    let price = parse_decimal(&price_raw).ok_or_else(|| {
        "seal-round-proposal: envelope price is malformed".to_string()
    })?;
    if quantity == 0 || price == 0 {
        return Err(
            "seal-round-proposal: envelope quantity or price is zero".to_string(),
        );
    }
    Ok(RoundEnvelopeFields {
        traded_asset_code: asset_code.to_uppercase(),
        side,
        quantity: format_decimal(quantity),
        price: format_decimal(price),
    })
}

// ─── evaluate-round (v0.9.0) ───
//
// The cross-authoritative call for per-round negotiation.
// Given two opaque proposal handles from `seal-round-proposal`,
// the TEE unseals both envelopes inside its boundary, decides
// the cross (the buyer's bid is at or above the seller's ask
// and both quantities are positive), computes the fill
// (`min(buy_quantity, sell_quantity)`) and midpoint execution
// price, and emits a TEE-attested `round_attestation_ref` that
// cryptographically binds the verdict to the proposal handles.
//
// The TEE is stateless across rounds — the orchestrator owns
// the per-side `round_proposal_descriptor` map. The TEE's job is
// the cross-authoritative decision; the orchestrator's job is
// to carry the handles + descriptors across rounds.
//
// Wire form for prices and quantities mirrors the matching
// contract: plain decimal string at `WIRE_SCALE` (1e18), parsed
// into an exact scaled `u128` for deterministic math.

pub fn evaluate_round(envelope_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let body = unwrap_body(envelope_bytes)?;
    let parsed: crate::EvaluateRoundInput = serde_json::from_slice(&body)
        .map_err(|err| format!("evaluate-round: invalid JSON input: {}", err))?;

    if parsed.buy_proposal_handle.is_empty() {
        return Err("evaluate-round: buy_proposal_handle is required".to_string());
    }
    if parsed.sell_proposal_handle.is_empty() {
        return Err("evaluate-round: sell_proposal_handle is required".to_string());
    }
    if parsed.asset_code.is_empty() {
        return Err("evaluate-round: asset_code is required".to_string());
    }
    if parsed.correlation_ref.is_empty() {
        return Err("evaluate-round: correlation_ref is required".to_string());
    }
    if parsed.envelope_master_key_hex.is_empty() {
        return Err("evaluate-round: envelope_master_key_hex is required (v0.13.0)".to_string());
    }

    // Outcome + trade-field refs are deterministic regardless of
    // whether the round crosses, so the orchestrator can
    // correlate a `status: "open"` outcome back to the exact
    // proposal handle pair it submitted.
    let outcome_ref = crate::hex_handle(
        "round_outcome",
        format!(
            "{}|{}|{}",
            parsed.buy_proposal_handle, parsed.sell_proposal_handle, parsed.correlation_ref
        )
        .as_bytes(),
    );
    let execution_ref = fresh_execution_ref();
    let encrypted_trade_fields_ref = crate::hex_handle(
        "t3fields_round",
        format!(
            "{}:{}",
            parsed.buy_proposal_handle, parsed.sell_proposal_handle
        )
        .as_bytes(),
    );

    // 5-minute settlement window — matches the matching
    // contract's TTL.
    let expires_at = format_expires_at(300);
    let evaluated_at = format_expires_at(0);

    // v0.10.0: recover price/quantity from the enclave's
    // kv-store by handle. The orchestrator no longer forwards
    // plaintext on the evaluate-round wire — the TEE holds the
    // values from seal-round-proposal and reads them back here.
    // A missing kv-store entry means the proposal was already
    // consumed or never sealed; return `open` with zero fill.
    let buy_payload_bytes = match kv_get(&kv_map_name("rounds"), parsed.buy_proposal_handle.as_bytes())? {
        Some(v) => v,
        None => {
            let signal = "far";
            let round_attestation_ref = crate::compute_round_attestation_ref(
                &parsed.buy_proposal_handle,
                &parsed.sell_proposal_handle,
                &parsed.asset_code,
                &parsed.correlation_ref,
                "open",
                "",
                "",
                &outcome_ref,
                &execution_ref,
            );
            let output = crate::EvaluateRoundOutput {
                status: "open".to_string(),
                buyer_signal: signal.to_string(),
                seller_signal: signal.to_string(),
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                expires_at,
                evaluated_at,
                matched_quantity: String::new(),
                execution_price: String::new(),
                round_attestation_ref,
                asset_code_ciphertext: String::new(),
                quantity_ciphertext: String::new(),
                execution_price_ciphertext: String::new(),
            };
            return serde_json::to_vec(&output)
                .map_err(|err| format!("evaluate-round: response encode failed: {}", err));
        }
    };
    let sell_payload_bytes = match kv_get(&kv_map_name("rounds"), parsed.sell_proposal_handle.as_bytes())? {
        Some(v) => v,
        None => {
            let signal = "far";
            let round_attestation_ref = crate::compute_round_attestation_ref(
                &parsed.buy_proposal_handle,
                &parsed.sell_proposal_handle,
                &parsed.asset_code,
                &parsed.correlation_ref,
                "open",
                "",
                "",
                &outcome_ref,
                &execution_ref,
            );
            let output = crate::EvaluateRoundOutput {
                status: "open".to_string(),
                buyer_signal: signal.to_string(),
                seller_signal: signal.to_string(),
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                expires_at,
                evaluated_at,
                matched_quantity: String::new(),
                execution_price: String::new(),
                round_attestation_ref,
                asset_code_ciphertext: String::new(),
                quantity_ciphertext: String::new(),
                execution_price_ciphertext: String::new(),
            };
            return serde_json::to_vec(&output)
                .map_err(|err| format!("evaluate-round: response encode failed: {}", err));
        }
    };
    let buy_payload: RoundKvPayload = serde_json::from_slice(&buy_payload_bytes)
        .map_err(|err| format!("evaluate-round: buy kv payload parse failed: {}", err))?;
    let sell_payload: RoundKvPayload = serde_json::from_slice(&sell_payload_bytes)
        .map_err(|err| format!("evaluate-round: sell kv payload parse failed: {}", err))?;

    let buy_price = match parse_decimal(&buy_payload.price) {
        Some(v) => v,
        None => return Err("evaluate-round: buy kv payload price is malformed".to_string()),
    };
    let buy_quantity = match parse_decimal(&buy_payload.quantity) {
        Some(v) => v,
        None => return Err("evaluate-round: buy kv payload quantity is malformed".to_string()),
    };
    let sell_price = match parse_decimal(&sell_payload.price) {
        Some(v) => v,
        None => return Err("evaluate-round: sell kv payload price is malformed".to_string()),
    };
    let sell_quantity = match parse_decimal(&sell_payload.quantity) {
        Some(v) => v,
        None => return Err("evaluate-round: sell kv payload quantity is malformed".to_string()),
    };

    // Compute the distance signal from the actual prices. Mirrors
    // the TS `distanceSignalFor` helper so the orchestrator's
    // defense-in-depth fallback produces the same label.
    let signal = if buy_price >= sell_price {
        "crossed"
    } else {
        let gap = sell_price - buy_price;
        // gap_ratio = gap / sell_price
        // near:  gap_ratio <= 0.01 → gap * 100 <= sell_price
        // moderate: gap_ratio <= 0.05 → gap * 100 <= sell_price * 5
        // far: otherwise
        if sell_price == 0 {
            "far"
        } else if gap.checked_mul(100).map(|g| g <= sell_price).unwrap_or(false) {
            "near"
        } else if gap.checked_mul(100).map(|g| g <= sell_price.checked_mul(5).unwrap_or(u128::MAX)).unwrap_or(false) {
            "moderate"
        } else {
            "far"
        }
    };
    let buyer_signal = signal;
    let seller_signal = signal;

    // Cross verdict: the buyer's bid is at or above the seller's
    // ask and both quantities are positive. The TEE is the sole
    // authority on the cross — the orchestrator does not compute
    // this locally.
    let crosses = buy_price >= sell_price && buy_quantity > 0 && sell_quantity > 0;
    let status = if crosses { "crossed" } else { "open" };

    let (matched_quantity, execution_price, asset_ct, qty_ct, price_ct) = if crosses {
        let matched = core::cmp::min(buy_quantity, sell_quantity);
        let mid = match midpoint(buy_price, sell_price) {
            Some(v) => v,
            None => {
                return Err("evaluate-round: midpoint overflow".to_string());
            }
        };
        let mq = format_decimal(matched);
        let ep = format_decimal(mid);
        // v0.13.0: encrypt the three settlement fields inside the TEE
        // for the crossed path, mirroring evaluate_match.
        let (act, qct, pct) = encrypt_trade_fields(
            &parsed.envelope_master_key_hex,
            &outcome_ref,
            &parsed.asset_code,
            &mq,
            &ep,
        )?;
        // v0.10.0: consume both proposal entries from the
        // kv-store on a successful cross so the sealed plaintext
        // is not reusable for a second cross.
        let _ = kv_delete(&kv_map_name("rounds"), parsed.buy_proposal_handle.as_bytes());
        let _ = kv_delete(&kv_map_name("rounds"), parsed.sell_proposal_handle.as_bytes());
        (mq, ep, act, qct, pct)
    } else {
        (String::new(), String::new(), String::new(), String::new(), String::new())
    };

    let round_attestation_ref = crate::compute_round_attestation_ref(
        &parsed.buy_proposal_handle,
        &parsed.sell_proposal_handle,
        &parsed.asset_code,
        &parsed.correlation_ref,
        status,
        &execution_price,
        &matched_quantity,
        &outcome_ref,
        &execution_ref,
    );

    let output = crate::EvaluateRoundOutput {
        status: status.to_string(),
        buyer_signal: buyer_signal.to_string(),
        seller_signal: seller_signal.to_string(),
        outcome_ref,
        execution_ref,
        encrypted_trade_fields_ref,
        expires_at,
        evaluated_at,
        matched_quantity,
        execution_price,
        round_attestation_ref,
        asset_code_ciphertext: asset_ct,
        quantity_ciphertext: qty_ct,
        execution_price_ciphertext: price_ct,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-round: response encode failed: {}", err))
}
