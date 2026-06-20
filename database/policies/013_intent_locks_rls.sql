alter table intent_locks enable row level security;

drop policy if exists intent_locks_service_role_all on intent_locks;
create policy intent_locks_service_role_all
  on intent_locks
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists intent_locks_institution_read on intent_locks;
create policy intent_locks_institution_read
  on intent_locks
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );
