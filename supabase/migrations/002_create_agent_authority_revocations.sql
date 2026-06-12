create table if not exists agent_authority_revocations (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references institutions(id) on delete cascade,
  agent_did text not null,
  authority_ref text not null,
  reason text not null check (
    reason in ('operator_revoked', 'policy_replaced', 'credential_compromised', 'terminal3_revoked')
  ),
  revoked_by text not null,
  revoked_at timestamptz not null default now(),
  unrevoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists agent_authority_revocations_active_idx
on agent_authority_revocations (institution_id, agent_did, authority_ref)
where unrevoked_at is null;

create index if not exists agent_authority_revocations_lookup_idx
on agent_authority_revocations (institution_id, agent_did)
where unrevoked_at is null;
