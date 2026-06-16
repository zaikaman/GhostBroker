-- Make GhostBroker's internal settlement write atomic with its
-- portfolio balance mutation. The chain/off-chain rail dispatch has
-- already happened by the time this RPC is called, so this function is
-- the transactional boundary for GhostBroker's own durable state.
--
-- Inputs:
--   completed_trade jsonb  - existing completed trade payload, now with
--                            rail proof fields
--   receipts jsonb         - existing receipt array payload
--   settlement_plaintext   - buyer/seller/asset/quantity/price used to
--                            apply portfolio deltas in the same txn
--
-- Behavior:
--   1. Validate both counterparties have sufficient balance.
--   2. Insert completed_trades row.
--   3. Insert audit_receipts rows.
--   4. Apply the four portfolio legs.
--   5. Return the inserted trade + receipts.
--
-- Any exception rolls the entire function back.

drop function if exists persist_completed_settlement(jsonb, jsonb);

create or replace function persist_completed_settlement(
  completed_trade jsonb,
  receipts jsonb,
  settlement_plaintext jsonb
) returns jsonb
language plpgsql
security definer
as $$
declare
  inserted_trade completed_trades%rowtype;
  receipt_item jsonb;
  inserted_receipts jsonb := '[]'::jsonb;
  inserted_receipt audit_receipts%rowtype;
  v_buyer_institution_id uuid;
  v_seller_institution_id uuid;
  v_asset_code text;
  v_quantity numeric;
  v_execution_price numeric;
  v_buyer_locked_amount numeric;
  v_seller_locked_amount numeric;
  v_total_cost numeric;
  v_buyer_cash_balance numeric;
  v_seller_asset_balance numeric;
begin
  v_buyer_institution_id := (settlement_plaintext ->> 'buyer_institution_id')::uuid;
  v_seller_institution_id := (settlement_plaintext ->> 'seller_institution_id')::uuid;
  v_asset_code := upper(settlement_plaintext ->> 'asset_code');
  v_quantity := (settlement_plaintext ->> 'quantity')::numeric;
  v_execution_price := (settlement_plaintext ->> 'execution_price')::numeric;
  v_buyer_locked_amount := coalesce(
    (settlement_plaintext ->> 'buyer_locked_amount')::numeric,
    v_quantity * v_execution_price
  );
  v_seller_locked_amount := coalesce(
    (settlement_plaintext ->> 'seller_locked_amount')::numeric,
    v_quantity
  );
  v_total_cost := v_quantity * v_execution_price;

  if v_asset_code is null or v_asset_code = '' then
    raise exception 'asset_code is required';
  end if;
  if v_quantity is null or v_quantity <= 0 then
    raise exception 'quantity must be positive, got %', v_quantity;
  end if;
  if v_execution_price is null or v_execution_price <= 0 then
    raise exception 'execution_price must be positive, got %', v_execution_price;
  end if;
  if v_buyer_locked_amount < 0 then
    raise exception 'buyer_locked_amount must be non-negative, got %', v_buyer_locked_amount;
  end if;
  if v_seller_locked_amount < 0 then
    raise exception 'seller_locked_amount must be non-negative, got %', v_seller_locked_amount;
  end if;

  insert into public.portfolios (institution_id, asset_code, balance, locked)
  values
    (v_buyer_institution_id, 'USDC', 0, 0),
    (v_buyer_institution_id, v_asset_code, 0, 0),
    (v_seller_institution_id, 'USDC', 0, 0),
    (v_seller_institution_id, v_asset_code, 0, 0)
  on conflict (institution_id, asset_code) do nothing;

  select balance
    into v_buyer_cash_balance
  from public.portfolios
  where institution_id = v_buyer_institution_id
    and asset_code = 'USDC'
  for update;

  if v_buyer_cash_balance is null or v_buyer_cash_balance < v_total_cost then
    raise exception
      'insufficient balance for USDC: requested %, available %',
      v_total_cost,
      coalesce(v_buyer_cash_balance, 0);
  end if;

  select balance
    into v_seller_asset_balance
  from public.portfolios
  where institution_id = v_seller_institution_id
    and asset_code = v_asset_code
  for update;

  if v_seller_asset_balance is null or v_seller_asset_balance < v_quantity then
    raise exception
      'insufficient balance for %: requested %, available %',
      v_asset_code,
      v_quantity,
      coalesce(v_seller_asset_balance, 0);
  end if;

  perform 1
  from public.portfolios
  where institution_id = v_buyer_institution_id
    and asset_code = v_asset_code
  for update;

  perform 1
  from public.portfolios
  where institution_id = v_seller_institution_id
    and asset_code = 'USDC'
  for update;

  insert into completed_trades (
    trade_ref,
    buy_institution_id,
    sell_institution_id,
    asset_code_ciphertext,
    quantity_ciphertext,
    execution_price_ciphertext,
    settlement_status,
    settled_at,
    t3_execution_ref,
    rail_id,
    rail_trade_ref,
    rail_state
  ) values (
    completed_trade ->> 'trade_ref',
    (completed_trade ->> 'buy_institution_id')::uuid,
    (completed_trade ->> 'sell_institution_id')::uuid,
    completed_trade ->> 'asset_code_ciphertext',
    completed_trade ->> 'quantity_ciphertext',
    completed_trade ->> 'execution_price_ciphertext',
    completed_trade ->> 'settlement_status',
    (completed_trade ->> 'settled_at')::timestamptz,
    completed_trade ->> 't3_execution_ref',
    completed_trade ->> 'rail_id',
    completed_trade ->> 'rail_trade_ref',
    completed_trade ->> 'rail_state'
  )
  returning * into inserted_trade;

  for receipt_item in select * from jsonb_array_elements(receipts)
  loop
    insert into audit_receipts (
      completed_trade_id,
      institution_id,
      receipt_ciphertext,
      receipt_hash,
      key_version,
      t3_attestation_ref,
      access_scope
    ) values (
      inserted_trade.id,
      (receipt_item ->> 'institution_id')::uuid,
      receipt_item ->> 'receipt_ciphertext',
      receipt_item ->> 'receipt_hash',
      receipt_item ->> 'key_version',
      receipt_item ->> 't3_attestation_ref',
      receipt_item ->> 'access_scope'
    )
    returning * into inserted_receipt;

    inserted_receipts := inserted_receipts || to_jsonb(inserted_receipt);
  end loop;

  update public.portfolios
  set balance = balance - v_total_cost,
      locked = greatest(locked - v_buyer_locked_amount, 0),
      updated_at = now()
  where institution_id = v_buyer_institution_id
    and asset_code = 'USDC';

  update public.portfolios
  set balance = balance + v_quantity,
      locked = least(locked, balance + v_quantity),
      updated_at = now()
  where institution_id = v_buyer_institution_id
    and asset_code = v_asset_code;

  update public.portfolios
  set balance = balance - v_quantity,
      locked = greatest(locked - v_seller_locked_amount, 0),
      updated_at = now()
  where institution_id = v_seller_institution_id
    and asset_code = v_asset_code;

  update public.portfolios
  set balance = balance + v_total_cost,
      locked = least(locked, balance + v_total_cost),
      updated_at = now()
  where institution_id = v_seller_institution_id
    and asset_code = 'USDC';

  return jsonb_build_object(
    'completed_trade',
    to_jsonb(inserted_trade),
    'receipts',
    inserted_receipts
  );
end;
$$;
