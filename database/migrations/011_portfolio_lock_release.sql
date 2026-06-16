-- Per-agent balance reservations.
-- A "reservation" locks a portion of an institution's balance while
-- a hidden intent is pending in the matching orchestrator. The lock
-- prevents the institution from over-committing its balance to
-- multiple intents that all think they can afford the same funds.
--
-- The lock amount is held in the existing `portfolios.locked`
-- column. Available balance for new intents is therefore
-- `balance - locked`. When a trade settles, `portfolio_update_balance`
-- already auto-clamps `locked = LEAST(locked, new_balance)`, so the
-- lock is released implicitly by settlement.
--
-- When an intent is cancelled or expires, the caller must explicitly
-- release the lock via `portfolio_release_balance` so that the
-- institution's available balance is restored before the TTL
-- settlement drains anything.
--
-- Both functions are SECURITY DEFINER and pinned to the public
-- schema so they can be invoked via the standard Supabase RPC
-- interface, matching the pattern used by `portfolio_update_balance`.

-- portfolio_lock_balance: atomically increment `locked` for a
-- (institution, asset) pair after asserting that there is
-- sufficient *available* balance (balance - locked >= amount).
-- Returns void. Raises an exception if available balance is
-- insufficient.
CREATE OR REPLACE FUNCTION public.portfolio_lock_balance(
  p_institution_id uuid,
  p_asset_code text,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_available numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'lock amount must be positive, got %', p_amount;
  END IF;

  -- Ensure a portfolios row exists so the subsequent SELECT FOR
  -- UPDATE always finds a row to lock. Default balance is 0.
  INSERT INTO public.portfolios (institution_id, asset_code, balance, locked)
  VALUES (p_institution_id, p_asset_code, 0, 0)
  ON CONFLICT (institution_id, asset_code) DO NOTHING;

  SELECT (balance - locked) INTO v_available
  FROM public.portfolios
  WHERE institution_id = p_institution_id
    AND asset_code = p_asset_code
  FOR UPDATE;

  IF v_available IS NULL OR v_available < p_amount THEN
    RAISE EXCEPTION
      'insufficient available balance for %: requested %, available %',
      p_asset_code, p_amount, COALESCE(v_available, 0);
  END IF;

  UPDATE public.portfolios
  SET locked = locked + p_amount,
      updated_at = now()
  WHERE institution_id = p_institution_id
    AND asset_code = p_asset_code;
END;
$$;

-- portfolio_release_balance: atomically decrement `locked`, with
-- `locked = GREATEST(locked - amount, 0)` to clamp underflow.
-- Safe to call on rows that don't exist (no-op). Safe to call with
-- `amount` greater than the current lock (clamped to zero, never
-- negative). Idempotent under repeated calls.
CREATE OR REPLACE FUNCTION public.portfolio_release_balance(
  p_institution_id uuid,
  p_asset_code text,
  p_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'release amount must be positive, got %', p_amount;
  END IF;

  UPDATE public.portfolios
  SET locked = GREATEST(locked - p_amount, 0),
      updated_at = now()
  WHERE institution_id = p_institution_id
    AND asset_code = p_asset_code;
END;
$$;
