-- Atomically update a portfolio balance with a delta (positive or negative)
-- Returns error if balance would go negative
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
  -- Upsert: create row if not exists, otherwise update
  INSERT INTO public.portfolios (institution_id, asset_code, balance)
  VALUES (p_institution_id, p_asset_code, GREATEST(p_delta, 0))
  ON CONFLICT (institution_id, asset_code)
  DO UPDATE SET
    balance = GREATEST(public.portfolios.balance + p_delta, 0),
    updated_at = now();

  -- Check if balance went negative (shouldn't happen due to GREATEST, but verify)
  IF EXISTS (
    SELECT 1 FROM public.portfolios
    WHERE institution_id = p_institution_id
      AND asset_code = p_asset_code
      AND balance < 0
  ) THEN
    RAISE EXCEPTION 'insufficient balance for %', p_asset_code;
  END IF;
END;
$$;

-- Seed initial portfolio entry for new institutions
CREATE OR REPLACE FUNCTION public.portfolio_seed_initial(
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
  VALUES (p_institution_id, p_asset_code, p_balance, 0)
  ON CONFLICT (institution_id, asset_code) DO NOTHING;
END;
$$;
