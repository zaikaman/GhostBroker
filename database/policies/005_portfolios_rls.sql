alter table portfolios enable row level security;

drop policy if exists portfolios_service_role_all on portfolios;
create policy portfolios_service_role_all
  on portfolios
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists portfolios_institution_read on portfolios;
create policy portfolios_institution_read
  on portfolios
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );
