alter table api_keys enable row level security;

drop policy if exists api_keys_service_role_all on api_keys;
create policy api_keys_service_role_all
  on api_keys
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists api_keys_institution_read on api_keys;
create policy api_keys_institution_read
  on api_keys
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );
