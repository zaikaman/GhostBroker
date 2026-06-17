-- Migration 017: authoritative escalation gating.
--
-- The previous design inferred escalation state from the latest round
-- row's `escalation_requested` column. That was decorative: a priced
-- cross would still settle even if a previous round flagged
-- escalation. This migration makes the gate authoritative by
-- persisting the escalation decision on the session itself.
--
-- We add:
--   * `escalation_status` column on `negotiation_sessions` with values
--     `none | pending | approved | declined`. The orchestrator gates
--     settlement on this column for any priced cross.
--   * `awaiting_approval` to the status check constraint so the
--     session can reflect the new pending state in its lifecycle
--     instead of being stuck on `active` while a decision is owed.
--   * `escalation_initiated_round_id` to record which round put the
--     session into awaiting_approval (informational only; the gate
--     checks `escalation_status`, not the round row).
--   * `escalation_resolved_at` to time-stamp the operator decision.

ALTER TABLE public.negotiation_sessions
  ADD COLUMN IF NOT EXISTS escalation_status text
    NOT NULL DEFAULT 'none'
    CHECK (escalation_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'declined'::text])),
  ADD COLUMN IF NOT EXISTS escalation_initiated_round_id uuid
    REFERENCES public.negotiation_rounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS escalation_resolved_at timestamp with time zone;

ALTER TABLE public.negotiation_sessions
  DROP CONSTRAINT IF EXISTS negotiation_sessions_status_check;
ALTER TABLE public.negotiation_sessions
  ADD CONSTRAINT negotiation_sessions_status_check
    CHECK (status = ANY (ARRAY[
      'pairing'::text,
      'active'::text,
      'awaiting_approval'::text,
      'converged'::text,
      'settling'::text,
      'settled'::text,
      'walked_away'::text,
      'expired'::text
    ]));

CREATE INDEX IF NOT EXISTS negotiation_sessions_escalation_pending_idx
  ON public.negotiation_sessions (status, escalation_status)
  WHERE status = 'awaiting_approval';