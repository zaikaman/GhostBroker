alter table published_contracts enable row level security;

drop policy if exists published_contracts_service_role_all on published_contracts;
create policy published_contracts_service_role_all
on published_contracts
for all
to service_role
using (true)
with check (true);
