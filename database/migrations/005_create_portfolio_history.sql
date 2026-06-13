-- Track all portfolio balance changes (audit trail for settlements)
-- Each row records a change to an institution's balance in one asset
CREATE TABLE IF NOT EXISTS public.portfolio_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  asset_code text NOT NULL,
  delta numeric(40, 8) NOT NULL,
  balance_after numeric(40, 8) NOT NULL,
  change_type text NOT NULL CHECK (change_type = ANY (ARRAY['settlement_buy'::text, 'settlement_sell'::text, 'adjustment'::text, 'import'::text])),
  reference_type text DEFAULT NULL,
  reference_id text DEFAULT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_history_pkey PRIMARY KEY (id)
);

-- Index for fast lookups by institution + asset, ordered by time desc
CREATE INDEX IF NOT EXISTS idx_portfolio_history_institution_asset
  ON public.portfolio_history (institution_id, asset_code, created_at DESC);

-- Index for reference lookups (e.g., find all history entries for a trade)
CREATE INDEX IF NOT EXISTS idx_portfolio_history_reference
  ON public.portfolio_history (reference_type, reference_id)
  WHERE reference_type IS NOT NULL;
