alter table tenant_identities enable row level security;

drop policy if exists tenant_identities_service_role_all on tenant_identities;
create policy tenant_identities_service_role_all
on tenant_identities
for all
to service_role
using (true)
with check (true);
