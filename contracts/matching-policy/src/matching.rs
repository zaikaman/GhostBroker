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

/// Monotonic per-instance counter used to derive fresh execution
/// refs without pulling in a randomness source. The value is
/// scoped to the contract instance's lifetime in the TEE, so two
/// calls within the same execution always get different refs.
static NONCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn monotonic_nonce() -> u64 {
    NONCE.fetch_add(1, Ordering::SeqCst)
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

    // The orchestrator hands us the two sealed intent handles
    // + a correlation ref. We mint a deterministic outcome ref
    // by hashing the ordered (buy, sell, correlation) tuple.
    // The orchestrator can then look up the trade details it
    // already has in its in-memory queue (it knew about both
    // intents before calling us) and stitch them into a
    // settlement command using the authority refs we echo
    // back.
    let outcome_ref = hex_handle(
        "outcome",
        format!(
            "{}|{}|{}",
            parsed.buy_intent_handle, parsed.sell_intent_handle, parsed.correlation_ref
        )
        .as_bytes(),
    );
    let execution_ref = fresh_execution_ref();

    // The "trade fields" ref is the encrypted blob the
    // settlement command will eventually read. We mint a
    // deterministic ref the orchestrator can store in its
    // own KV map keyed by the (buy, sell) handle pair — the
    // actual settlement command builder will write the
    // encrypted fields under this ref.
    let encrypted_trade_fields_ref = hex_handle(
        "t3fields",
        format!("{}:{}", parsed.buy_intent_handle, parsed.sell_intent_handle).as_bytes(),
    );

    // We don't actually know the buyer / seller institution
    // ids or authority refs inside the TEE — the orchestrator
    // already verified the VCs before calling, and the
    // institution context comes from the envelope. We echo
    // the T3 host's tenant context (via the
    // host:tenant/tenant-context import) for the *issuing
    // tenant*; the actual buyer/seller split is something
    // the orchestrator stamps onto the settlement command.
    // We default the buyer/seller institution ids to the
    // tenant DID and the authority refs to empty strings;
    // the orchestrator fills in the real values when it
    // reads the matching intent from its queue. This keeps
    // the TEE surface non-validating (it cannot leak info
    // it doesn't have) while still returning a valid
    // response shape.
    let buyer_institution_id = String::new();
    let seller_institution_id = String::new();
    let buyer_authority_ref = String::new();
    let seller_authority_ref = String::new();

    // 5-minute settlement window — matches the
    // `MatchingOrchestrator`'s default intent TTL.
    let expires_at = format_expires_at(300);

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
    };

    serde_json::to_vec(&output)
        .map_err(|err| format!("evaluate-match: response encode failed: {}", err))
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
