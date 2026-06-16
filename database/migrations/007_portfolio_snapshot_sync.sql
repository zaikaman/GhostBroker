-- Upgrade portfolio support to production snapshot sync.
-- This migration is safe to apply to databases that already ran earlier versions.

CREATE OR REPLACE FUNCTION public.portfolio_update_balance(
  p_institution_id uuid,
  p_asset_code text,
  p_delta numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.portfolios (institution_id, asset_code, balance)
  VALUES (p_institution_id, p_asset_code, GREATEST(p_delta, 0))
  ON CONFLICT (institution_id, asset_code)
  DO UPDATE SET
    balance = GREATEST(public.portfolios.balance + p_delta, 0),
    locked = LEAST(public.portfolios.locked, GREATEST(public.portfolios.balance + p_delta, 0)),
    updated_at = now();

  IF EXISTS (
    SELECT 1 FROM public.portfolios
    WHERE institution_id = p_institution_id
      AND asset_code = p_asset_code
      AND (balance < 0 OR locked > balance)
  ) THEN
    RAISE EXCEPTION 'insufficient balance for %', p_asset_code;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.portfolio_sync_balance(
  p_institution_id uuid,
  p_asset_code text,
  p_balance numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.portfolios (institution_id, asset_code, balance, locked)
  VALUES (p_institution_id, p_asset_code, GREATEST(p_balance, 0), 0)
  ON CONFLICT (institution_id, asset_code)
  DO UPDATE SET
    balance = GREATEST(p_balance, 0),
    locked = LEAST(public.portfolios.locked, GREATEST(p_balance, 0)),
    updated_at = now();
END;
$$;

ALTER TABLE public.portfolio_history
  DROP CONSTRAINT IF EXISTS portfolio_history_change_type_check;

ALTER TABLE public.portfolio_history
  ADD CONSTRAINT portfolio_history_change_type_check
  CHECK (change_type = ANY (ARRAY['settlement_buy'::text, 'settlement_sell'::text, 'adjustment'::text, 'import'::text]));

DROP FUNCTION IF EXISTS public.portfolio_seed_initial(uuid, text, numeric);
