//! Core logic for the matching contract.
//!
//! The two exported functions (`seal_intent`, `evaluate_match`)
//! parse the JSON payload, compute deterministic opaque handles,
//! and return a JSON response. All host imports are intentionally
//! unused here — the contract is a pure function. The dispatcher
//! still validates that the WASM exposes the required WIT world,
//! which gives us a verifiable execution surface even though the
//! body is pure.

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::sync::atomic::{AtomicU64, Ordering};

use crate::{
    fresh_execution_ref, hex_handle, EvaluateMatchInput, EvaluateMatchOutput, OuterEnvelope,
    SealIntentInput, SealIntentOutput,
};

/// Parse a non-negative decimal string into a `u128`. Rejects empty
/// strings, leading `+`, signs, exponents, fractions, and underscores
/// — the wire form is always a plain integer of base-10 digits, so a
/// anything else means the caller (the backend) sent a malformed
/// quantity/price and the pair must be a `no_match`, not a silent
/// fill at a garbage price.
fn parse_decimal_u128(value: &str) -> Option<u128> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut accumulated: u128 = 0;
    for byte in trimmed.bytes() {
        if !byte.is_ascii_digit() {
            return None;
        }
        accumulated = match accumulated.checked_mul(10) {
            Some(v) => v,
            None => return None,
        };
        let digit = u128::from(byte - b'0');
        accumulated = match accumulated.checked_add(digit) {
            Some(v) => v,
            None => return None,
        };
    }
    Some(accumulated)
}

/// Deterministic midpoint of two unsigned prices: `(a + b) / 2`
/// rounded half-up. Uses `u128` throughout so there is no float
/// drift, and `checked_add` so an overflow is reported as `None`
/// (the caller treats that as `no_match` rather than wrapping).
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
    if parsed.correlation_ref.is_empty() {
        return Err("seal-ticket: correlation_ref is required".to_string());
    }

    // The ticket handle is the canonical TEE seal identifier.
    // Hash a stable concatenation of all the input fields so
    // (a) the same input always maps to the same handle, and
    // (b) different inputs are guaranteed to map to different
    // handles (within SHA-256 collision probability).
    let mut hasher_input: Vec<u8> = Vec::with_capacity(
        parsed.institution_id.len()
            + parsed.agent_did.len()
            + parsed.authority_ref.len()
            + parsed.asset_code.len()
            + parsed.side.len()
            + parsed.policy_hash.len()
            + parsed.compatibility_token.len()
            + parsed.correlation_ref.len()
            + 7,
    );
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
    hasher_input.extend_from_slice(parsed.correlation_ref.as_bytes());

    let ticket_handle = crate::hex_handle("ticket", &hasher_input);
    let execution_ref = fresh_execution_ref();

    let output = crate::SealTicketOutput {
        ticket_handle,
        execution_ref,
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("seal-ticket: response encode failed: {}", err))
}

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
    if parsed.authority_ref.is_empty() {
        return Err("seal-intent: authority_ref is required".to_string());
    }
    if parsed.correlation_ref.is_empty() {
        return Err("seal-intent: correlation_ref is required".to_string());
    }

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

    let output = SealIntentOutput {
        intent_handle,
        execution_ref,
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

    // The TEE does not have buyer/seller institution context, so
    // these stay empty and the orchestrator stamps the verified
    // values from its pending-intent queue before settlement.
    let buyer_institution_id = String::new();
    let seller_institution_id = String::new();
    let buyer_authority_ref = String::new();
    let seller_authority_ref = String::new();

    // 5-minute settlement window — matches the
    // `MatchingOrchestrator`'s default intent TTL.
    let expires_at = format_expires_at(300);

    // Parse the price/quantity wire fields into exact u128. Any
    // malformed or missing value is a hard `no_match` — the
    // contract must never fill at a price it could not parse.
    let buy_price = match parse_decimal_u128(&parsed.buy_price) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                buyer_institution_id,
                seller_institution_id,
                buyer_authority_ref,
                seller_authority_ref,
                expires_at,
            );
        }
    };
    let buy_quantity = match parse_decimal_u128(&parsed.buy_quantity) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                buyer_institution_id,
                seller_institution_id,
                buyer_authority_ref,
                seller_authority_ref,
                expires_at,
            );
        }
    };
    let sell_price = match parse_decimal_u128(&parsed.sell_price) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                buyer_institution_id,
                seller_institution_id,
                buyer_authority_ref,
                seller_authority_ref,
                expires_at,
            );
        }
    };
    let sell_quantity = match parse_decimal_u128(&parsed.sell_quantity) {
        Some(v) if v > 0 => v,
        _ => {
            return no_match_output(
                outcome_ref,
                execution_ref,
                encrypted_trade_fields_ref,
                buyer_institution_id,
                seller_institution_id,
                buyer_authority_ref,
                seller_authority_ref,
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
            buyer_institution_id,
            seller_institution_id,
            buyer_authority_ref,
            seller_authority_ref,
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
                buyer_institution_id,
                seller_institution_id,
                buyer_authority_ref,
                seller_authority_ref,
                expires_at,
            );
        }
    };

    let output = EvaluateMatchOutput {
        outcome_ref,
        execution_ref,
        buyer_institution_id,
        seller_institution_id,
        encrypted_trade_fields_ref,
        buyer_authority_ref,
        seller_authority_ref,
        expires_at,
        status: "matched".to_string(),
        matched_quantity: matched_quantity.to_string(),
        execution_price: execution_price.to_string(),
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-match: response encode failed: {}", err))
}

/// Build a `no_match` outcome. Every opaque ref the caller needs to
/// correlate the decision is still present (outcome_ref, trade-field
/// ref, expiry); the fill fields are empty so the client can detect
/// the non-cross without parsing the status.
#[allow(clippy::too_many_arguments)]
fn no_match_output(
    outcome_ref: String,
    execution_ref: String,
    encrypted_trade_fields_ref: String,
    buyer_institution_id: String,
    seller_institution_id: String,
    buyer_authority_ref: String,
    seller_authority_ref: String,
    expires_at: String,
) -> Result<Vec<u8>, String> {
    let output = EvaluateMatchOutput {
        outcome_ref,
        execution_ref,
        buyer_institution_id,
        seller_institution_id,
        encrypted_trade_fields_ref,
        buyer_authority_ref,
        seller_authority_ref,
        expires_at,
        status: "no_match".to_string(),
        matched_quantity: String::new(),
        execution_price: String::new(),
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-match: no_match encode failed: {}", err))
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
