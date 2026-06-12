create table if not exists audit_receipts (
  id uuid primary key default gen_random_uuid(),
  completed_trade_id uuid not null references completed_trades(id) on delete cascade,
  institution_id uuid not null references institutions(id),
  receipt_ciphertext text not null,
  receipt_hash text not null,
  key_version text not null,
  t3_attestation_ref text not null,
  access_scope text not null check (access_scope in ('buyer', 'seller', 'regulatory_export')),
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  check (receipt_ciphertext <> ''),
  check (receipt_hash <> ''),
  check (key_version <> ''),
  check (t3_attestation_ref <> '')
);

create index if not exists audit_receipts_completed_trade_idx
  on audit_receipts (completed_trade_id);

create index if not exists audit_receipts_institution_idx
  on audit_receipts (institution_id, created_at desc);

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
    t3_execution_ref
  ) values (
    completed_trade ->> 'trade_ref',
    (completed_trade ->> 'buy_institution_id')::uuid,
    (completed_trade ->> 'sell_institution_id')::uuid,
    completed_trade ->> 'asset_code_ciphertext',
    completed_trade ->> 'quantity_ciphertext',
    completed_trade ->> 'execution_price_ciphertext',
    completed_trade ->> 'settlement_status',
    (completed_trade ->> 'settled_at')::timestamptz,
    completed_trade ->> 't3_execution_ref'
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
