create table if not exists completed_trades (
  id uuid primary key default gen_random_uuid(),
  trade_ref text not null unique,
  buy_institution_id uuid not null references institutions(id),
  sell_institution_id uuid not null references institutions(id),
  asset_code_ciphertext text not null,
  quantity_ciphertext text not null,
  execution_price_ciphertext text not null,
  settlement_status text not null check (settlement_status in ('settled', 'failed', 'reversed')),
  settled_at timestamptz not null,
  t3_execution_ref text not null,
  created_at timestamptz not null default now(),
  check (buy_institution_id <> sell_institution_id),
  check (asset_code_ciphertext <> ''),
  check (quantity_ciphertext <> ''),
  check (execution_price_ciphertext <> ''),
  check (t3_execution_ref <> '')
);

create index if not exists completed_trades_buy_institution_idx
  on completed_trades (buy_institution_id, settled_at desc);

create index if not exists completed_trades_sell_institution_idx
  on completed_trades (sell_institution_id, settled_at desc);
