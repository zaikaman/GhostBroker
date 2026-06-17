-- Negotiation pivot: AI-first authored mandates.
--
-- GhostBroker is now an AI-first confidential negotiation venue. The
-- operator authors a high-level policy mandate (objective, size policy,
-- urgency, execution style, valuation policy, concession policy,
-- disclosure policy, approval/escalation policy, counterparty requirements,
-- operator instructions). The numeric execution rails (reference price,
-- price band, max notional, reservation bounds, concession envelope) are
-- DERIVED from that authored policy by the backend's strategy normalizer
-- and persisted here so the enclave/contract can still enforce hard
-- bounds deterministically.
--
-- The legacy trader-style columns (reference_price, price_band_bps,
-- max_notional) are retained as derived rails for the existing
-- contract/orchestrator authority path. They are no longer the authored
-- surface; new UI/API only writes the authored_* columns.

ALTER TABLE public.negotiation_mandates
  ADD COLUMN IF NOT EXISTS objective text,
  ADD COLUMN IF NOT EXISTS execution_style text
    CHECK (execution_style IS NULL OR execution_style = ANY (ARRAY[
      'patient'::text,
      'balanced'::text,
      'aggressive'::text,
      'relationship_first'::text,
      'trust_first'::text
    ])),
  ADD COLUMN IF NOT EXISTS valuation_policy jsonb,
  ADD COLUMN IF NOT EXISTS concession_policy jsonb,
  ADD COLUMN IF NOT EXISTS disclosure_policy jsonb,
  ADD COLUMN IF NOT EXISTS approval_policy jsonb,
  ADD COLUMN IF NOT EXISTS counterparty_requirements jsonb,
  ADD COLUMN IF NOT EXISTS size_policy jsonb,
  ADD COLUMN IF NOT EXISTS time_window jsonb,
  ADD COLUMN IF NOT EXISTS operator_instructions text,
  ADD COLUMN IF NOT EXISTS minimum_quantity numeric(40, 8),
  ADD COLUMN IF NOT EXISTS partial_execution_allowed boolean,
  -- Derived execution rails, written by the strategy normalizer.
  -- Kept nullable so a legacy mandate (authored_* all NULL) can still
  -- be read by the compatibility codepath.
  ADD COLUMN IF NOT EXISTS derived_anchor_value numeric(40, 8),
  ADD COLUMN IF NOT EXISTS derived_walkaway_min numeric(40, 8),
  ADD COLUMN IF NOT EXISTS derived_walkaway_max numeric(40, 8),
  ADD COLUMN IF NOT EXISTS derived_concession_budget_bps integer,
  ADD COLUMN IF NOT EXISTS derived_notional_ceiling numeric(40, 8),
  -- Opaque decision telemetry mirror: the LLM's strategic signal per
  -- session turn, persisted for the dashboard "why the AI matters" view
  -- without leaking live terms. Stored as jsonb; the redactor scrubs it
  -- before it crosses the operator websocket.
  ADD COLUMN IF NOT EXISTS decision_meta jsonb DEFAULT '{}'::jsonb;

-- decision_meta lives per-round, so add a column on the rounds table too:
-- the actor's declared strategic intent / confidence for that move.
ALTER TABLE public.negotiation_rounds
  ADD COLUMN IF NOT EXISTS strategic_intent text,
  ADD COLUMN IF NOT EXISTS confidence numeric(3, 2),
  ADD COLUMN IF NOT EXISTS escalation_requested boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS settlement_readiness text
    CHECK (settlement_readiness IS NULL OR settlement_readiness = ANY (ARRAY[
      'not_ready'::text,
      'near'::text,
      'ready'::text
    ]));

-- Make the authored objective the primary surface once present. Existing
-- operator_prompt stays for compatibility; objective replaces it in the
-- new authored contract.
