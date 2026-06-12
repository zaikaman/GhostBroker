alter table completed_trades enable row level security;

drop policy if exists completed_trades_service_role_all on completed_trades;
create policy completed_trades_service_role_all
  on completed_trades
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists completed_trades_institution_read on completed_trades;
create policy completed_trades_institution_read
  on completed_trades
  for select
  using (
    auth.role() = 'authenticated'
    and (
      buy_institution_id::text = auth.jwt() ->> 'institution_id'
      or sell_institution_id::text = auth.jwt() ->> 'institution_id'
    )
  );
