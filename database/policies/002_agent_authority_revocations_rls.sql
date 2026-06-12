alter table agent_authority_revocations enable row level security;

drop policy if exists agent_authority_revocations_service_role_all on agent_authority_revocations;
create policy agent_authority_revocations_service_role_all
on agent_authority_revocations
for all
to service_role
using (true)
with check (true);
