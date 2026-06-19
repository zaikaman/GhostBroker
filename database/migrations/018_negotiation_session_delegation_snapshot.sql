-- Migration 018: snapshot per-side Ghostbroker delegation VCs onto
-- the negotiation session.
--
-- The settlement command builder re-verifies both the buyer and
-- seller's delegation W3C VC at settlement time. Before this
-- migration, the orchestrator looked the VCs up at settlement by
-- reading the agent's `metadata.delegation_credential` JSONB. That
-- left three production holes:
--
--   1. A Supabase transient error in the lookup at settlement time
--      silently returned `null` and the settlement command builder
--      threw `SettlementAuthorityError` deep in the request path.
--   2. The operator could re-mint the agent's delegation between
--      `openNegotiation` and `settle` ("Regenerate Delegation"),
--      which would silently swap the credential that settlement
--      re-verified. A new VC could carry different `allowedActions`
--      or `maxSpendUsd` than the one that authorized the
--      negotiation rounds.
--   3. The in-memory test repository carried an explicit
--      `delegationCredentials` map that the production code path
--      silently bypassed, so test coverage did not exercise the
--      real null-credential failure mode.
--
-- The fix: at session creation, the orchestrator snapshots the
-- VCs it just verified (via `loadAndVerify`) into a JSONB column
-- on the session itself. The snapshot is the authoritative VC for
-- the entire session lifecycle. Settlement reads the snapshot, so
-- a later re-mint or a transient DB error in the agent-record
-- lookup cannot change which credential is re-verified.
--
-- The JSONB shape is:
--
--   {
--     "buy":  <delegation VC> | null,
--     "sell": <delegation VC> | null
--   }
--
-- A `null` slot means the orchestrator never had a VC to snapshot
-- (e.g. legacy session created before this migration ran). The
-- settlement command builder treats a null snapshot the same as a
-- null inline credential and refuses to settle.

ALTER TABLE public.negotiation_sessions
  ADD COLUMN IF NOT EXISTS delegation_credentials jsonb
    NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.negotiation_sessions.delegation_credentials IS
  'Per-side Ghostbroker delegation W3C VCs snapshotted at session creation. The settlement command builder re-verifies these VCs verbatim at settlement time. A null slot indicates the orchestrator never snapshotted a VC for that side; the settlement command builder fails closed on null.';
