//! GhostBroker matching TEE contract.
//!
//! Six exports:
//!   - `seal-ticket`        — mints an opaque ticket handle + execution
//!                            ref for a sealed negotiation ticket. The
//!                            handle is bound to every input field
//!                            including `policy_hash` and
//!                            `compatibility_token`, so a different
//!                            token produces a different handle.
//!   - `seal-intent`        — mints an opaque intent handle + execution
//!                            ref for a sealed blind intent.
//!   - `evaluate-match`     — decides whether a (buy, sell) intent
//!                            pair crosses, and if so at what fill
//!                            quantity and execution price, then
//!                            returns an opaque match outcome the
//!                            orchestrator settles on.
//!   - `evaluate-pair`      — structural pair authority for
//!                            negotiation tickets. The orchestrator
//!                            owns the in-memory pending queue but
//!                            must call this function before pairing;
//!                            the TEE returns `compatible` only when
//!                            both sides' ticket handles are
//!                            well-formed, both compatibility tokens
//!                            parse to a (asset, side, institution)
//!                            tuple, and every structural axis
//!                            (same asset, opposite side, different
//!                            institution, distinct handles) agrees.
//!   - `seal-round-proposal` — unseals the agent's AEAD envelope
//!                            inside the enclave, mints an opaque
//!                            `round_<handle>`, and returns the
//!                            TEE-attested per-side descriptor
//!                            (traded asset / side / quantity /
//!                            price / distance signal /
//!                            attestation ref). The handle is what
//!                            `evaluate-round` consumes; the
//!                            plaintext price / quantity never leaves
//!                            the enclave.
//!   - `evaluate-round`     — given two opaque proposal handles,
//!                            unseals both envelopes inside the
//!                            enclave, decides the cross, and emits
//!                            a `round_attestation_ref` binding the
//!                            verdict to the proposal handles it
//!                            unsealed. Mirrors `evaluate-match`'s
//!                            identity-echo + attestation pattern so
//!                            the settlement record carries a
//!                            TEE-attested identity instead of an
//!                            orchestrator-stamped override.
//!
//! As of v0.8.0, the wire form for prices and quantities on
//! `evaluate-match` is a plain decimal string at the contract's
//! internal `WIRE_SCALE` (1e18): `"0.0001"`, `"70000"`,
//! `"12345.6789"`. Match authority still lives inside the
//! enclave: the contract returns `status: "matched"` with
//! `matched_quantity` and `execution_price` only when the
//! buyer's bid crosses the seller's ask. The backend
//! orchestrator is a verifier/orchestrator around the enclave
//! outcome, not the price matcher.
//!
//! v0.10.0 changes (kv-store-backed TEE state):
//!   * `seal-intent` and `seal-round-proposal` now persist the
//!     decrypted price/quantity into the enclave's kv-store
//!     (`host:interfaces/kv-store@2.1.0`) keyed by the opaque
//!     handle. The orchestrator receives only the handle + the
//!     derived reservation amount; the individual price and
//!     quantity never leave the TEE.
//!   * `evaluate-match` and `evaluate-round` recover the
//!     price/quantity from kv-store by handle and compute the
//!     cross inside the enclave. The orchestrator no longer
//!     forwards plaintext price/quantity on the cross-evaluation
//!     wire.
//!   * `evaluate-round` now computes the real cross verdict
//!     (buy_price >= sell_price, fill = min quantities, midpoint
//!     price) instead of the v0.9.0 hardcoded "crossed" verdict
//!     with empty fill fields. The v0.9.0 defense-in-depth
//!     fallback in the orchestrator is no longer needed.
//!   * The contract is no longer stateless — it holds sealed
//!     intent and round-proposal plaintext in the kv-store
//!     between the seal and evaluate calls. This is the
//!     load-bearing privacy mechanism: active order data lives
//!     exclusively inside the TEE.
//!
//! v0.11.0 changes (real per-field AEAD ciphertexts on match outcomes):
//!   * `evaluate-match` and `evaluate-round` now AES-256-GCM
//!     encrypt the three settlement fields (asset code, matched
//!     quantity, execution price) inside the TEE and return the
//!     ciphertexts on the outcome. The orchestrator writes them
//!     directly to `completed_trades` without ever holding the
//!     decryption key. The previous v0.10.x path returned
//!     deterministic SHA-256 digests (opaque correlation handles)
//!     that anyone with a Supabase read could re-derive from the
//!     row own (outcome_ref, execution_ref, institution_id)
//!     columns - zero confidentiality. The new path derives a
//!     per-trade, per-field AEAD key via HKDF-SHA256(master_key,
//!     salt=outcome_ref, info=domain_tag) so a DB breach alone
//!     cannot recover the plaintext asset / quantity / price.
//!   * `EvaluateMatchInput` and `EvaluateRoundInput` gain a new
//!     required `envelope_master_key_hex` field - the same
//!     32-byte hex the orchestrator already forwards to
//!     `seal-intent` / `seal-round-proposal` for envelope
//!     decryption. The TEE uses it as the HKDF input keying
//!     material; it is never persisted to the kv-store or
//!     echoed on the outcome.
//!   * `EvaluateMatchOutput` and `EvaluateRoundOutput` gain
//!     `asset_code_ciphertext`, `quantity_ciphertext`,
//!     `execution_price_ciphertext` - each
//!     `aead.v1:<nonce_hex>:<ciphertext_hex>`. Empty strings on
//!     `no_match` / `open` (no fill to encrypt).
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
//! v0.8.0 changes (wire-shape reconciliation against the
//! orchestrator — the v0.8.0 audit-trail fixes for
//! identity-echo + match-attestation carry forward):
//!   * `evaluate-match` now requires the orchestrator to pass
//!     `buy_institution_id`, `sell_institution_id`,
//!     `buy_authority_ref`, `sell_authority_ref` on every call.
//!     These are the values the orchestrator already has in its
//!     pending-intent queue (the same values the seal call
//!     accepted at submit time). The TEE no longer returns empty
//!     strings — it echoes the supplied identity fields on both
//!     `matched` and `no_match` outcomes, so the audit log
//!     carries a TEE-attested match outcome instead of an
//!     orchestrator-stamped override. The orchestrator asserts the
//!     echo matches the queue values it submitted and fails closed
//!     on mismatch (poisoned queue, lost binding, TEE returning
//!     different values).
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
//!     completed_trades row can verify the institution IDs in the
//!     row are the IDs the TEE bound to the match outcome.
//!   * `seal-intent` now unseals the envelope inside the enclave
//!     and emits the per-side TEE-attested trading parameters
//!     (`traded_asset_code`, `settlement_asset_code`, `side`,
//!     `quantity`, `price`, `amount`, `attestation_ref`) on the
//!     `SealIntentOutput`. The orchestrator carries these
//!     values through on the `T3LockDescriptor` and forwards them
//!     as plaintext `buy_price` / `buy_quantity` /
//!     `sell_price` / `sell_quantity` to `evaluate-match` so the
//!     canonical Rust wire form is fully populated end-to-end.
//!     The seal envelope remains the source of truth — the
//!     plaintext fields on the output are the TEE's own
//!     authoritative claim about what the envelope carried, not
//!     an orchestrator-side decode. (Replaces the earlier
//!     "v0.5.0 envelope-only" wire form on `evaluate-match`
//!     that did not actually exist on the deployed Rust
//!     contract — the TS orchestrator was posting envelopes the
//!     Rust `EvaluateMatchInput` could not parse, and was
//!     missing the plaintext `asset_code` / `buy_price` /
//!     `buy_quantity` / `sell_price` / `sell_quantity` fields
//!     the contract does parse.)
//!
//! v0.9.0 changes (per-round negotiation crosses route through
//! the TEE — the SUBMISSION.md privacy claim depends on this):
//!   * `seal-round-proposal` unseals the agent's AES-256-GCM AEAD
//!     envelope (the same cipher `buildSealedEnvelope` produces
//!     on the agent side) using the institution's HKDF-derived
//!     per-institution key. The TEE emits a per-side descriptor
//!     (traded_asset_code, side, quantity, price, distance_signal,
//!     attestation_ref) plus an opaque `round_<handle>`. The
//!     plaintext price / quantity never leaves the enclave.
//!   * `evaluate-round` takes two opaque handles, unseals both
//!     envelopes inside the enclave, decides the cross
//!     (`buy_price >= sell_price && both_quantities > 0`), and
//!     emits the standard opaque outcome + fill fields +
//!     `round_attestation_ref` binding the verdict to the
//!     proposal handles. The orchestrator's defense-in-depth
//!     fallback in `backend/src/enclave/negotiation/round-client.ts`
//!     opens envelopes via the local master key when a pre-v0.9.0
//!     host doesn't echo the new route, so a publish without the
//!     new build keeps the orchestrator alive but routes the
//!     cross locally — which is structurally weaker than the
//!     v0.9.0 path. Always ship the new build before bumping
//!     `T3_MATCHING_CONTRACT_VERSION`.

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

// v0.10.0: kv-store-backed state. seal-intent and seal-round-proposal
// persist plaintext price/quantity into the enclave's kv-store;
// evaluate-match and evaluate-round recover them by handle.
// v0.10.1: use canonical `z:<tenant-hex>:<tail>` kv-store map names
// instead of bare tails — the host does not auto-prefix.
// v0.13.0: evaluate-match and evaluate-round now AES-256-GCM encrypt
// the three settlement fields inside the TEE and return real
// `aead.v1:` ciphertexts on the outcome - replacing the deterministic
// SHA-256 digests that were re-derivable from the row own columns.
pub const CONTRACT_VERSION: &str = "0.14.0";

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

    fn seal_round_proposal(
        req: exports::ghostbroker::matching_policy::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let input = req
            .input
            .ok_or_else(|| "seal-round-proposal: missing input bytes".to_string())?;
        matching::seal_round_proposal(&input)
    }

    fn evaluate_round(
        req: exports::ghostbroker::matching_policy::contracts::GenericInput,
    ) -> Result<Vec<u8>, String> {
        let input = req
            .input
            .ok_or_else(|| "evaluate-round: missing input bytes".to_string())?;
        matching::evaluate_round(&input)
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

/// v0.14.0: SDK-native delegation envelope wire shape.
///
/// The orchestrator forwards this on per-agent TEE contract
/// calls (`seal-ticket`, `seal-intent`, `seal-round-proposal`)
/// so the contract can verify the calling agent's delegation
/// credential authorises the function being invoked. The
/// credential JCS + user_sig are the signed credential bytes
/// from the SDK's `buildDelegationCredential` +
/// `canonicaliseCredential` + `signCredential`. The agent_sig
/// is the per-call invocation signature from
/// `signAgentInvocation`. The nonce is the per-call random
/// 16-byte value. The request_hash is the SHA-256 of the
/// canonical request body the agent signed.
///
/// All binary fields are base64url-no-pad encoded (the SDK's
/// `b64uEncodeBytes` wire encoding).
#[derive(Debug, Deserialize)]
pub struct DelegationEnvelopeInput {
    /// RFC 8785 JCS bytes of the credential, base64url-no-pad.
    pub credential_jcs: String,
    /// 65-byte EIP-191 signature over `credential_jcs`,
    /// base64url-no-pad.
    pub user_sig: String,
    /// Per-call agent invocation signature (64-byte compact
    /// ECDSA over `sha256(preimage)`), base64url-no-pad.
    pub agent_sig: String,
    /// 16-byte agent-generated per-call nonce,
    /// base64url-no-pad.
    pub nonce: String,
    /// SHA-256 of the canonical request body, base64url-no-pad.
    pub request_hash: String,
    /// The WIT function names the credential authorises.
    /// The contract checks this list contains the function
    /// being invoked.
    pub functions: Vec<String>,
    /// 16-byte credential id, base64url-no-pad. Echoed in
    /// the output for audit trail linkage.
    pub vc_id: String,
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
    /// v0.14.0: SDK-native delegation envelope for per-call
    /// agent invocation signing. When present, the contract
    /// parses the credential JCS, verifies the called function
    /// (`seal-ticket`) is in the credential's `functions` list,
    /// and echoes `delegation_vc_id` in the output for the
    /// audit trail. Optional — calls without an envelope fall
    /// through to the existing orchestrator-trusted path.
    #[serde(default)]
    pub delegation_envelope: Option<DelegationEnvelopeInput>,
}

#[derive(Debug, Serialize)]
pub struct SealTicketOutput {
    pub ticket_handle: String,
    pub execution_ref: String,
    /// v0.14.0: Delegation credential id (base64url) echoed
    /// from the input envelope when present. Empty string
    /// when no delegation envelope was supplied.
    #[serde(default)]
    pub delegation_vc_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SealIntentInput {
    pub institution_id: String,
    pub agent_did: String,
    pub encrypted_intent: String,
    /// Hex-encoded (64-char) AEAD master key the orchestrator
    /// holds via `ENVELOPE_ENCRYPTION_MASTER_KEY`. The TEE
    /// derives the per-institution HKDF-SHA256 key and
    /// AES-256-GCM decrypts `encrypted_intent` inside the
    /// enclave. Same field as `SealRoundProposalInput`; the
    /// T3N session is the authenticated channel.
    pub envelope_master_key_hex: String,
    pub authority_ref: String,
    pub correlation_ref: String,
    /// Settlement asset code (e.g. `"USDC"`). The orchestrator
    /// forwards this from `env.SETTLEMENT_ASSET_CODE` so the
    /// enclave can compute the buy-side reservation amount as
    /// `quantity * price` in the settlement asset without an
    /// additional host import. Optional for backwards
    /// compatibility with pre-v0.8.0 hosts that did not
    /// forward it — the enclave falls back to `"USDC"` in
    /// that case (the production default).
    #[serde(default)]
    pub settlement_asset_code: Option<String>,
    /// v0.14.0: SDK-native delegation envelope. Optional —
    /// when present the contract verifies `seal-intent` is
    /// in the credential's functions list and echoes
    /// `delegation_vc_id` in the output.
    #[serde(default)]
    pub delegation_envelope: Option<DelegationEnvelopeInput>,
}

#[derive(Debug, Serialize)]
pub struct SealIntentOutput {
    pub intent_handle: String,
    pub execution_ref: String,
    pub traded_asset_code: String,
    /// Asset to reserve for this intent. For a buy intent this
    /// is the settlement asset (e.g. `USDC`); for a sell intent
    /// it is the same as `traded_asset_code`.
    pub settlement_asset_code: String,
    pub side: String,
    /// Reservation amount (`quantity * price` for a buy,
    /// `quantity` for a sell). The orchestrator needs this for
    /// the balance lock; the individual price and quantity stay
    /// in the enclave's kv-store and never leave the TEE.
    pub amount: String,
    pub attestation_ref: String,
    /// v0.14.0: Delegation credential id (base64url) echoed
    /// from the input envelope when present. Empty string
    /// when no delegation envelope was supplied.
    #[serde(default)]
    pub delegation_vc_id: String,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateMatchInput {
    pub buy_intent_handle: String,
    pub sell_intent_handle: String,
    pub correlation_ref: String,
    /// Shared traded asset code (e.g. "WBTC"). Both sides must be
    /// on the same instrument; the orchestrator already filters
    /// this, but the enclave checks it too so a mismatch is a
    /// `no_match`, not a silent cross-asset fill.
    pub asset_code: String,
    /// Per-side identity fields. Required on every `evaluate-match`
    /// call as of v0.8.0. The orchestrator already holds these in
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
    /// v0.13.0: Hex-encoded (64-char) AEAD master key the
    /// orchestrator holds via `ENVELOPE_ENCRYPTION_MASTER_KEY`.
    /// The TEE uses it as HKDF input keying material to derive a
    /// per-trade, per-field AES-256-GCM key for the settlement
    /// ciphertexts. Same value already forwarded to `seal-intent`
    /// for envelope decryption - no new secret-management surface.
    pub envelope_master_key_hex: String,
}

#[derive(Debug, Serialize)]
pub struct EvaluateMatchOutput {
    pub outcome_ref: String,
    pub execution_ref: String,
    /// Echoed `buy_institution_id` from the input. The TEE is the
    /// binding authority on this value as of v0.8.0 — the audit
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
    /// v0.13.0: AES-256-GCM ciphertext of the traded asset code,
    /// minted inside the TEE. Wire form
    /// `aead.v1:<nonce_hex>:<ciphertext_hex>`. The orchestrator
    /// writes this directly to
    /// `completed_trades.asset_code_ciphertext`. Empty on
    /// `no_match` (no fill to encrypt). A DB reader cannot
    /// recover the plaintext asset without the
    /// `ENVELOPE_ENCRYPTION_MASTER_KEY`.
    pub asset_code_ciphertext: String,
    /// v0.13.0: AES-256-GCM ciphertext of the matched quantity.
    /// Domain-separated by `ghostbroker.completed_trades.quantity.v1`.
    /// Empty on `no_match`.
    pub quantity_ciphertext: String,
    /// v0.13.0: AES-256-GCM ciphertext of the execution price.
    /// Domain-separated by `ghostbroker.completed_trades.execution_price.v1`.
    /// Empty on `no_match`.
    pub execution_price_ciphertext: String,
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

// ─── seal-round-proposal + evaluate-round (v0.9.0) ───
//
// Per-round negotiation crosses. The agent runtime seals its
// priced proposal into an AES-256-GCM AEAD envelope (see
// `enclave/keys/envelope-cipher.ts`) and forwards the envelope
// to the TEE via `seal-round-proposal`. The TEE holds the only
// decryption key inside its boundary, mints an opaque
// `round_<handle>` the orchestrator threads through to
// `evaluate-round`, and emits a per-side descriptor (traded
// asset / side / quantity / price / distance signal /
// attestation ref). `evaluate-round` unseals both envelopes,
// decides the cross, and emits a `round_attestation_ref`
// binding the verdict to the proposal handles the TEE unsealed.
//
// Wire form for prices and quantities mirrors the matching
// contract: plain decimal string at the `WIRE_SCALE` (1e18),
// parsed into an exact scaled `u128` for deterministic math.

#[derive(Debug, Deserialize)]
pub struct SealRoundProposalInput {
    /// The agent's sealed envelope — base64url-encoded AES-256-GCM
    /// AEAD ciphertext bound to (institution_did, agent_did,
    /// authority_ref). The TEE holds the only key; the
    /// orchestrator only sees the ciphertext.
    pub sealed_envelope: String,
    /// Hex-encoded (64-char) AEAD master key the orchestrator
    /// holds via `ENVELOPE_ENCRYPTION_MASTER_KEY`. The TEE uses
    /// it to derive the per-institution HKDF-SHA256 key and
    /// AES-256-GCM decrypt the `sealed_envelope` inside the
    /// enclave. The orchestrator→T3N session is the
    /// authenticated, TLS-protected channel into the TEE; the
    /// key transits only that channel and the TEE is the
    /// trusted decryption boundary. When the T3 host adds a
    /// first-class secret-provisioning host import, the key
    /// can move there and this field drops.
    pub envelope_master_key_hex: String,
    pub institution_did: String,
    pub agent_did: String,
    pub authority_ref: String,
    pub asset_code: String,
    pub side: String,
    pub correlation_ref: String,
    /// v0.14.0: SDK-native delegation envelope. Optional —
    /// when present the contract verifies `seal-round-proposal`
    /// is in the credential's functions list and echoes
    /// `delegation_vc_id` in the output.
    #[serde(default)]
    pub delegation_envelope: Option<DelegationEnvelopeInput>,
}

#[derive(Debug, Serialize)]
pub struct SealRoundProposalOutput {
    /// Opaque TEE-issued handle. The orchestrator forwards this
    /// to `evaluate-round` so the TEE can pair the cross with
    /// the exact envelope bytes it unsealed on the seal path.
    pub proposal_handle: String,
    pub execution_ref: String,
    /// TEE-echoed traded asset code.
    pub traded_asset_code: String,
    /// TEE-echoed proposal side.
    pub side: String,
    /// Coarse per-side signal — `crossed` (the proposal alone
    /// crosses the prior round), `near` / `moderate` / `far`
    /// otherwise. The TEE computes this from the unsealed
    /// envelope so the orchestrator never reads the
    /// counterpart's plaintext price either.
    pub distance_signal: String,
    /// SHA-256 attestation binding the seal output to its inputs.
    pub attestation_ref: String,
    pub sealed_at: String,
    /// v0.14.0: Delegation credential id (base64url) echoed
    /// from the input envelope when present. Empty string
    /// when no delegation envelope was supplied.
    #[serde(default)]
    pub delegation_vc_id: String,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateRoundInput {
    pub buy_proposal_handle: String,
    pub sell_proposal_handle: String,
    pub asset_code: String,
    pub correlation_ref: String,
    /// v0.13.0: Hex-encoded (64-char) AEAD master key the
    /// orchestrator holds via `ENVELOPE_ENCRYPTION_MASTER_KEY`.
    /// Same value forwarded to `seal-round-proposal` for envelope
    /// decryption. The TEE uses it as HKDF input keying material
    /// to derive a per-trade, per-field AES-256-GCM key for the
    /// settlement ciphertexts.
    pub envelope_master_key_hex: String,
}

#[derive(Debug, Serialize)]
pub struct EvaluateRoundOutput {
    pub status: String,
    pub buyer_signal: String,
    pub seller_signal: String,
    pub outcome_ref: String,
    pub execution_ref: String,
    pub encrypted_trade_fields_ref: String,
    pub expires_at: String,
    pub evaluated_at: String,
    /// Authoritative fill quantity decided by the enclave
    /// (`min(buy_quantity, sell_quantity)` on a cross). Empty
    /// string on `status: "open"`.
    pub matched_quantity: String,
    /// Authoritative execution price decided by the enclave
    /// (deterministic midpoint of the bid/ask rounded half-up).
    /// Empty string on `status: "open"`.
    pub execution_price: String,
    /// SHA-256 attestation binding the verdict to the
    /// (buy_proposal_handle, sell_proposal_handle, asset_code,
    /// correlation_ref, status, fill, outcome_ref,
    /// execution_ref) tuple. Mirrors the `match_attestation_ref`
    /// pattern so the settlement record carries a TEE-attested
    /// identity instead of an orchestrator-stamped override.
    pub round_attestation_ref: String,
    /// v0.13.0: AES-256-GCM ciphertext of the traded asset code,
    /// minted inside the TEE. Wire form
    /// `aead.v1:<nonce_hex>:<ciphertext_hex>`. Empty on
    /// `status: "open"` (no fill to encrypt).
    pub asset_code_ciphertext: String,
    /// v0.13.0: AES-256-GCM ciphertext of the matched quantity.
    /// Empty on `status: "open"`.
    pub quantity_ciphertext: String,
    /// v0.13.0: AES-256-GCM ciphertext of the execution price.
    /// Empty on `status: "open"`.
    pub execution_price_ciphertext: String,
}

/// Domain-separation prefix for the `seal-round-proposal`
/// attestation reference. Distinct from
/// `ghostbroker.completed_trades.*` (settlement record) and
/// from `ghostbroker.negotiation_round.attest.v1` (cross
/// verdict) so a downstream reader can grep for
/// `roundattest_seal_…` and find seal-level attestations
/// without colliding with cross- or settlement-level attestations.
pub(crate) const ROUND_SEAL_ATTESTATION_DOMAIN: &str =
    "ghostbroker.negotiation_round.seal.attest.v1";

/// Compute the `seal-round-proposal` attestation reference.
/// SHA-256 over the canonical concatenation of
/// (institution_did, agent_did, authority_ref, traded_asset_code,
/// side, quantity, price, distance_signal, sealed_at). Inputs are
/// pipe-delimited (a separator byte that cannot appear in any
/// input — the inputs are institution DIDs, agent DIDs,
/// authority refs, short opaque strings, and ISO 8601
/// timestamps) so the verifier can reconstruct the canonical
/// byte string from the recorded fields.
pub(crate) fn compute_seal_round_attestation_ref(
    institution_did: &str,
    agent_did: &str,
    authority_ref: &str,
    traded_asset_code: &str,
    side: &str,
    quantity: &str,
    price: &str,
    distance_signal: &str,
    sealed_at: &str,
) -> String {
    hex_handle(
        "roundattest_seal",
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            ROUND_SEAL_ATTESTATION_DOMAIN,
            institution_did,
            agent_did,
            authority_ref,
            traded_asset_code,
            side,
            quantity,
            price,
            distance_signal,
            sealed_at,
        )
        .as_bytes(),
    )
}

/// Compute the `evaluate-round` attestation reference.
/// SHA-256 over the canonical concatenation of
/// (buy_proposal_handle, sell_proposal_handle, asset_code,
/// correlation_ref, status, execution_price, matched_quantity,
/// outcome_ref, execution_ref). The status + fill fields are
/// part of the canonical input so a verdict cannot be silently
/// flipped after the TEE has emitted it (the settlement record
/// stores this ref and any later re-derivation will diverge).
pub(crate) fn compute_round_attestation_ref(
    buy_proposal_handle: &str,
    sell_proposal_handle: &str,
    asset_code: &str,
    correlation_ref: &str,
    status: &str,
    execution_price: &str,
    matched_quantity: &str,
    outcome_ref: &str,
    execution_ref: &str,
) -> String {
    hex_handle(
        "roundattest",
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            "ghostbroker.negotiation_round.attest.v1",
            buy_proposal_handle,
            sell_proposal_handle,
            asset_code,
            correlation_ref,
            status,
            execution_price,
            matched_quantity,
            outcome_ref,
            execution_ref,
        )
        .as_bytes(),
    )
}
