-- Negotiation pivot: confidential institutional negotiation agents.
--
-- A negotiation session is a private, sealed, turn-based bilateral
-- conversation between two delegated agents about one block trade
-- (same asset, opposite sides, different institutions). The mandate
-- is bound into the agent's delegation VC and covered by policy_hash;
-- this table is the operator-facing durable record of that mandate.
--
-- All price/quantity material that could leak a reservation threshold
-- is held as ciphertext. Current standing proposals are visible to the
-- counterpart by design and surfaced through the redacted session view;
-- identity, mandate, reservation thresholds, and balances are never
-- exchanged.

CREATE TABLE IF NOT EXISTS public.negotiation_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  agent_did text NOT NULL CHECK (agent_did <> ''),
  asset_code text NOT NULL CHECK (asset_code <> ''),
  side text NOT NULL CHECK (side = ANY (ARRAY['buy'::text, 'sell'::text])),
  target_quantity numeric(40, 8) NOT NULL CHECK (target_quantity > 0),
  reference_price numeric(40, 8) NOT NULL CHECK (reference_price > 0),
  price_band_bps integer NOT NULL CHECK (price_band_bps >= 0 AND price_band_bps <= 100000),
  deadline timestamptz NOT NULL,
  urgency text NOT NULL CHECK (urgency = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'critical'::text])),
  max_notional numeric(40, 8) NOT NULL CHECK (max_notional > 0),
  disclosable_claims text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_counterparty_claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  counterparty_constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator_prompt text NOT NULL CHECK (operator_prompt <> ''),
  policy_hash text NOT NULL CHECK (policy_hash <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_mandates_institution
  ON public.negotiation_mandates (institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_negotiation_mandates_agent
  ON public.negotiation_mandates (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_negotiation_mandates_agent_active
  ON public.negotiation_mandates (agent_id);

CREATE OR REPLACE FUNCTION set_negotiation_mandates_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS negotiation_mandates_updated_at_trigger ON public.negotiation_mandates;
CREATE TRIGGER negotiation_mandates_updated_at_trigger
  BEFORE UPDATE ON public.negotiation_mandates
  FOR EACH ROW
  EXECUTE FUNCTION set_negotiation_mandates_updated_at();

CREATE TABLE IF NOT EXISTS public.negotiation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code text NOT NULL CHECK (asset_code <> ''),
  buy_institution_id uuid NOT NULL REFERENCES public.institutions(id),
  sell_institution_id uuid NOT NULL REFERENCES public.institutions(id),
  buy_agent_did text NOT NULL CHECK (buy_agent_did <> ''),
  sell_agent_did text NOT NULL CHECK (sell_agent_did <> ''),
  buy_mandate_id uuid NOT NULL REFERENCES public.negotiation_mandates(id),
  sell_mandate_id uuid NOT NULL REFERENCES public.negotiation_mandates(id),
  status text NOT NULL DEFAULT 'pairing'
    CHECK (status = ANY (ARRAY[
      'pairing'::text,
      'active'::text,
      'converged'::text,
      'settling'::text,
      'settled'::text,
      'walked_away'::text,
      'expired'::text
    ])),
  current_turn text NOT NULL DEFAULT 'buy'
    CHECK (current_turn = ANY (ARRAY['buy'::text, 'sell'::text])),
  round_number integer NOT NULL DEFAULT 0 CHECK (round_number >= 0),
  max_rounds integer NOT NULL CHECK (max_rounds > 0),
  deadline timestamptz NOT NULL,
  trade_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_buy_institution
  ON public.negotiation_sessions (buy_institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_sell_institution
  ON public.negotiation_sessions (sell_institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_status
  ON public.negotiation_sessions (status);

DROP TRIGGER IF EXISTS negotiation_sessions_updated_at_trigger ON public.negotiation_sessions;
CREATE TRIGGER negotiation_sessions_updated_at_trigger
  BEFORE UPDATE ON public.negotiation_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_negotiation_mandates_updated_at();

CREATE TABLE IF NOT EXISTS public.negotiation_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.negotiation_sessions(id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number >= 0),
  actor_did text NOT NULL CHECK (actor_did <> ''),
  actor_side text NOT NULL CHECK (actor_side = ANY (ARRAY['buy'::text, 'sell'::text])),
  move_type text NOT NULL
    CHECK (move_type = ANY (ARRAY[
      'propose'::text,
      'counter'::text,
      'reveal'::text,
      'request_disclosure'::text,
      'accept'::text,
      'hold'::text,
      'walkaway'::text
    ])),
  proposal_ciphertext text,
  disclosed_claim_refs text[] NOT NULL DEFAULT ARRAY[]::text[],
  opaque_signal text,
  reasoning text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_rounds_session
  ON public.negotiation_rounds (session_id, round_number ASC);

CREATE TABLE IF NOT EXISTS public.negotiation_disclosures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.negotiation_sessions(id) ON DELETE CASCADE,
  from_did text NOT NULL CHECK (from_did <> ''),
  from_side text NOT NULL CHECK (from_side = ANY (ARRAY['buy'::text, 'sell'::text])),
  claim_type text NOT NULL CHECK (claim_type <> ''),
  claim_assertion_ciphertext text NOT NULL CHECK (claim_assertion_ciphertext <> ''),
  verified boolean NOT NULL DEFAULT false,
  t3_attestation_ref text NOT NULL CHECK (t3_attestation_ref <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_disclosures_session
  ON public.negotiation_disclosures (session_id, created_at ASC);

-- Link a settled trade back to the negotiation session that produced it.
ALTER TABLE IF EXISTS public.completed_trades
  ADD COLUMN IF NOT EXISTS negotiation_session_id uuid
    REFERENCES public.negotiation_sessions(id);

CREATE INDEX IF NOT EXISTS idx_completed_trades_negotiation_session
  ON public.completed_trades (negotiation_session_id)
  WHERE negotiation_session_id IS NOT NULL;