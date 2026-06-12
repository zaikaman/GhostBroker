alter table institutions enable row level security;

drop policy if exists institutions_service_role_all on institutions;
create policy institutions_service_role_all
on institutions
for all
to service_role
using (true)
with check (true);

drop policy if exists institutions_scoped_read on institutions;
create policy institutions_scoped_read
on institutions
for select
to authenticated
using (
  id::text = coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'institution_id',
    ''
  )
);
