alter table portfolio_history enable row level security;

drop policy if exists portfolio_history_service_role_all on portfolio_history;
create policy portfolio_history_service_role_all
  on portfolio_history
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists portfolio_history_institution_read on portfolio_history;
create policy portfolio_history_institution_read
  on portfolio_history
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );
