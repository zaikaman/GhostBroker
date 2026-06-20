alter table agents enable row level security;

drop policy if exists agents_service_role_all on agents;
create policy agents_service_role_all
  on agents
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists agents_institution_read on agents;
create policy agents_institution_read
  on agents
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );
