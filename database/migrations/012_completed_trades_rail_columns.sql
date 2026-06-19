-- WS1 (settlement-rails): additive columns for rail transport proof.
-- The rail proof is what makes a `completed_trades` row auditable end-to-end:
--   - `rail_id` is the SettlementRail implementation that handled the trade
--     ("chain:sepolia:erc20" — GhostBroker exposes a single settlement rail).
--   - `rail_trade_ref` is the rail-specific transport identifier (an on-chain
--     tx hash for the chain rail). Stored as text, no uniqueness constraint
--     — the `trade_ref` column (the TEE outcome) is the canonical unique key.
--   - `rail_state` mirrors `settlement_status` for symmetry with the
--     reconciliation/reversal flows planned in WS4.
--   - `reconciled_at` is set by the WS4 reconciler after a successful
--     post-settlement rail state check.
-- All columns are nullable. Pre-WS1 rows are pre-rail, which is the
-- correct historical state.

ALTER TABLE public.completed_trades
  ADD COLUMN IF NOT EXISTS rail_id text,
  ADD COLUMN IF NOT EXISTS rail_trade_ref text,
  ADD COLUMN IF NOT EXISTS rail_state text
    CHECK (rail_state IS NULL OR rail_state = ANY (ARRAY['settled'::text, 'failed'::text, 'reversed'::text])),
  ADD COLUMN IF NOT EXISTS reconciled_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS completed_trades_rail_trade_ref_idx
  ON public.completed_trades (rail_trade_ref)
  WHERE rail_trade_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS completed_trades_rail_state_idx
  ON public.completed_trades (rail_state)
  WHERE rail_state IS NOT NULL;

-- Update the canonical persist RPC to also store the rail proof.
-- The function is `security definer`; we keep that. The new columns
-- are passed via the same `completed_trade` jsonb blob (the settlement
-- service knows all the fields), so the RPC signature is unchanged
-- and existing call sites do not break.

create or replace function persist_completed_settlement(
  completed_trade jsonb,
  receipts jsonb
) returns jsonb
language plpgsql
security definer
as $$
declare
  inserted_trade completed_trades%rowtype;
  receipt_item jsonb;
  inserted_receipts jsonb := '[]'::jsonb;
  inserted_receipt audit_receipts%rowtype;
begin
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

  return jsonb_build_object(
    'completed_trade',
    to_jsonb(inserted_trade),
    'receipts',
    inserted_receipts
  );
end;
$$;
